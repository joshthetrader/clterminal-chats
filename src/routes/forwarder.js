// API Forwarder routes for proxying external APIs

const https = require('https');
const http = require('http');
const { URL } = require('url');
const { ALLOWED_UPSTREAMS, BLOFIN_ALLOWED_HEADERS, BITUNIX_ALLOWED_HEADERS, httpsAgent, httpAgent, UPSTREAM_TIMEOUT_MS } = require('../config/constants');
const { pickHeaders, buildUpstreamUrl } = require('../middleware/validation');

const TICKER_CACHE_TTL = 30000; // 30s shared cache
const tickerCache = new Map(); // cacheKey -> { status, contentType, body, ts }
const pendingTickerFetches = new Map(); // cacheKey -> Promise

function setPreflightHeaders(reply, allowHeaders, origin) {
  reply.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  reply.header('Access-Control-Allow-Headers', allowHeaders);
  reply.header('Access-Control-Allow-Origin', origin || '*');
  reply.header('Access-Control-Allow-Credentials', 'true');
  reply.header('Access-Control-Max-Age', '600');
}

const isTickerEndpoint = (parsedUrl) => {
  const hostname = parsedUrl.hostname;
  const pathname = parsedUrl.pathname.toLowerCase();

  if (hostname === 'openapi.blofin.com' && pathname.includes('/market/tickers')) return true;
  if ((hostname === 'fapi.bitunix.com' || hostname === 'api.bitunix.com') && pathname.includes('/market/tickers')) return true;
  return false;
};

async function forwardRequest(upstreamUrl, req, reply, allowedHeaderSet) {
  const startTime = Date.now();
  try {
    // Validate upstream
    try {
      const u = new URL(upstreamUrl);
      if (!ALLOWED_UPSTREAMS.has(u.hostname)) {
        return reply.code(400).send({ error: 'Upstream not allowed' });
      }
    } catch (_) {
      return reply.code(400).send({ error: 'Invalid upstream URL' });
    }

    // Sanitize headers
    const incoming = req.headers || {};
    const sanitized = pickHeaders(incoming, allowedHeaderSet);
    delete sanitized['cookie'];
    delete sanitized['origin'];
    delete sanitized['referer'];

    const controller = new AbortController();
    const timeoutMs = Number(UPSTREAM_TIMEOUT_MS || 5000);
    const t = setTimeout(() => controller.abort(), timeoutMs);
    const method = (req.method || 'GET').toUpperCase();

    // Body handling
    let body = undefined;
    if (method !== 'GET' && method !== 'HEAD') {
      if (req.body && typeof req.body === 'object') {
        body = JSON.stringify(req.body);
      } else if (req.body) {
        body = String(req.body);
      }
    }

    // Connection pooling agent
    const parsedUrl = new URL(upstreamUrl);
    const agent = parsedUrl.protocol === 'https:' ? httpsAgent : httpAgent;

    const cacheable = method === 'GET' && isTickerEndpoint(parsedUrl);
    const cacheKey = cacheable ? parsedUrl.toString() : null;
    const origin = req.headers.origin || '*';

    const performRequest = async () => {
      const fetchStart = Date.now();
      const res = await fetch(upstreamUrl, {
        method,
        headers: sanitized,
        body,
        signal: controller.signal,
        agent
      }).catch((e) => {
        throw e;
      });
      clearTimeout(t);
      
      const fetchTime = Date.now() - fetchStart;
      const totalTime = Date.now() - startTime;
      
      if (method === 'POST' && (upstreamUrl.includes('/trade/') || upstreamUrl.includes('/order'))) {
        console.log(`⚡ [FORWARDER] ${method} ${parsedUrl.pathname} -> ${res.status} (fetch: ${fetchTime}ms, total: ${totalTime}ms)`);
      }

      const bodyBuf = Buffer.from(await res.arrayBuffer());
      return {
        status: res.status,
        ok: res.ok,
        contentType: res.headers.get('content-type'),
        body: bodyBuf
      };
    };

    const sendResult = (result, cacheHeader) => {
      reply.code(result.status);
      if (result.contentType) reply.header('content-type', result.contentType);
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Access-Control-Allow-Credentials', 'true');
      if (cacheHeader) reply.header('X-Ticker-Cache', cacheHeader);
      return reply.send(Buffer.from(result.body));
    };

    if (cacheable && cacheKey) {
      const cached = tickerCache.get(cacheKey);
      if (cached && Date.now() - cached.ts < TICKER_CACHE_TTL) {
        return sendResult(cached, 'HIT');
      }

      if (pendingTickerFetches.has(cacheKey)) {
        const pendingResult = await pendingTickerFetches.get(cacheKey);
        if (pendingResult) {
          return sendResult(pendingResult, 'HIT');
        }
      }

      const execPromise = performRequest().then(result => {
        if (result.ok) {
          tickerCache.set(cacheKey, {
            status: result.status,
            contentType: result.contentType,
            body: Buffer.from(result.body),
            ts: Date.now()
          });
        }
        return result;
      }).finally(() => {
        pendingTickerFetches.delete(cacheKey);
      });
      pendingTickerFetches.set(cacheKey, execPromise);

      const freshResult = await execPromise;
      return sendResult(freshResult, freshResult.ok ? 'MISS' : 'BYPASS');
    }

    const result = await performRequest();
    return sendResult(result, null);
  } catch (e) {
    const code = e?.name === 'AbortError' ? 504 : 502;
    console.error(`[FORWARDER] ${method} ${upstreamUrl} failed:`, e?.message || e);
    return reply.code(code).send({ error: 'Upstream error' });
  }
}

// Image proxy cache with 1-hour TTL
const imageCache = new Map();
const CACHE_TTL = 3600000; // 1 hour in milliseconds

// Warm up connections
const warmupConnections = () => {
  const hosts = ['https://openapi.blofin.com', 'https://fapi.bitunix.com'];
  hosts.forEach(host => {
    fetch(`${host}/`, { agent: httpsAgent }).catch(() => {});
  });
};

setTimeout(warmupConnections, 1000);

module.exports = function(app) {
  // Blofin
  app.options('/api/blofin/*', async (req, reply) => {
    setPreflightHeaders(reply, 'Content-Type, ACCESS-KEY, ACCESS-SIGN, ACCESS-TIMESTAMP, ACCESS-PASSPHRASE, ACCESS-NONCE, BROKER-ID', req.headers.origin);
    return reply.send();
  });
  app.route({
    method: ['GET','POST','PUT','DELETE'],
    url: '/api/blofin/*',
    handler: async (req, reply) => {
      const suffix = req.params['*'] || '';
      let normalized = String(suffix).replace(/^\/+/, '');
      if (!normalized.startsWith('api/')) {
        normalized = `api/${normalized}`;
      }
      const search = req.raw.url.includes('?') ? req.raw.url.slice(req.raw.url.indexOf('?')) : '';
      const upstream = buildUpstreamUrl('https://openapi.blofin.com/', normalized, search);
      return forwardRequest(upstream, req, reply, BLOFIN_ALLOWED_HEADERS);
    }
  });

  // Bitunix public
  app.options('/api/bitunix/*', async (req, reply) => {
    setPreflightHeaders(reply, 'Content-Type', req.headers.origin);
    return reply.send();
  });
  app.route({
    method: ['GET','POST','PUT','DELETE'],
    url: '/api/bitunix/*',
    handler: async (req, reply) => {
      const suffix = req.params['*'] || '';
      const search = req.raw.url.includes('?') ? req.raw.url.slice(req.raw.url.indexOf('?')) : '';
      const upstream = buildUpstreamUrl('https://fapi.bitunix.com/', suffix, search);
      return forwardRequest(upstream, req, reply, new Set(['content-type']));
    }
  });

  // Bitunix private
  app.options('/api/bitunix-private/*', async (req, reply) => {
    setPreflightHeaders(reply, 'Content-Type, api-key, sign, timestamp, nonce', req.headers.origin);
    return reply.send();
  });
  app.route({
    method: ['GET','POST','PUT','DELETE'],
    url: '/api/bitunix-private/*',
    handler: async (req, reply) => {
      const suffix = req.params['*'] || '';
      const search = req.raw.url.includes('?') ? req.raw.url.slice(req.raw.url.indexOf('?')) : '';
      const upstream = buildUpstreamUrl('https://fapi.bitunix.com/', suffix, search);
      return forwardRequest(upstream, req, reply, BITUNIX_ALLOWED_HEADERS);
    }
  });

  // Bitunix alt
  app.options('/api/bitunix-alt/*', async (req, reply) => {
    setPreflightHeaders(reply, 'Content-Type', req.headers.origin);
    return reply.send();
  });
  app.route({
    method: ['GET','POST','PUT','DELETE'],
    url: '/api/bitunix-alt/*',
    handler: async (req, reply) => {
      const suffix = req.params['*'] || '';
      const search = req.raw.url.includes('?') ? req.raw.url.slice(req.raw.url.indexOf('?')) : '';
      const upstream = buildUpstreamUrl('https://api.bitunix.com/', suffix, search);
      return forwardRequest(upstream, req, reply, new Set(['content-type']));
    }
  });

  // Polymarket
  app.options('/api/polymarket/*', async (req, reply) => {
    setPreflightHeaders(reply, 'Content-Type', req.headers.origin);
    return reply.send();
  });
  app.route({
    method: ['GET','POST','PUT','DELETE'],
    url: '/api/polymarket/*',
    handler: async (req, reply) => {
      const suffix = req.params['*'] || '';
      const search = req.raw.url.includes('?') ? req.raw.url.slice(req.raw.url.indexOf('?')) : '';
      const upstream = buildUpstreamUrl('https://gamma-api.polymarket.com/', suffix, search);
      return forwardRequest(upstream, req, reply, new Set(['content-type']));
    }
  });

  // Image proxy to avoid browser social-tracking blocks (e.g. Twitter avatars)
  // WITH IN-MEMORY CACHING (Phase 2 optimization)
  app.get('/img-proxy', async (req, reply) => {
    const url = req.query.url;
    if (!url) {
      return reply.status(400).send('Missing url parameter');
    }

    try {
      const target = new URL(url);
      
      // Check cache first
      const cacheKey = target.toString();
      if (imageCache.has(cacheKey)) {
        const cached = imageCache.get(cacheKey);
        if (Date.now() - cached.time < CACHE_TTL) {
          reply.header('Content-Type', cached.contentType);
          reply.header('Cache-Control', 'public, max-age=3600');
          reply.header('Access-Control-Allow-Origin', '*');
          reply.header('X-Cache', 'HIT');
          return reply.send(cached.buffer);
        } else {
          imageCache.delete(cacheKey);
        }
      }
      
      // Allowlist common image hosts
      const allowedHosts = [
        'pbs.twimg.com',
        'abs.twimg.com',
        'polymarket-upload.s3.us-east-2.amazonaws.com',
        'pbs-pbs-twimg.cdn.twitter.com',
        'ton.twitter.com'
      ];

      // Check against exact match or wildcard patterns
      const hostname = target.hostname;
      const isAllowed = allowedHosts.some(h => 
        hostname === h || 
        (h.endsWith('.com') && hostname.endsWith('.com')) ||
        hostname.includes('s3') && hostname.includes('amazonaws.com') ||
        hostname.includes('cloudfront.net')
      );

      if (!isAllowed) {
        console.warn(`[IMG-PROXY] Blocked: ${hostname}`);
        return reply.status(403).send('Host not allowed');
      }

      // Use native http/https module for more reliability
      return new Promise((resolve, reject) => {
        const protocol = target.protocol === 'https:' ? https : http;
        const options = {
          hostname: target.hostname,
          port: target.port,
          path: target.pathname + target.search,
          method: 'GET',
          timeout: 8000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': 'https://twitter.com/'
          }
        };

        const req2 = protocol.request(options, (res2) => {
          const chunks = [];
          
          res2.on('data', (chunk) => chunks.push(chunk));
          
          res2.on('end', () => {
            try {
              const buf = Buffer.concat(chunks);
              const contentType = res2.headers['content-type'] || 'image/jpeg';
              
              // Cache the response
              imageCache.set(cacheKey, {
                buffer: buf,
                contentType: contentType,
                time: Date.now()
              });
              
              reply.header('Content-Type', contentType);
              reply.header('Cache-Control', 'public, max-age=3600');
              reply.header('Access-Control-Allow-Origin', '*');
              reply.header('X-Cache', 'MISS');
              reply.send(buf);
              resolve();
            } catch (e) {
              reject(e);
            }
          });
        });

        req2.on('timeout', () => {
          req2.destroy();
          reject(new Error('Request timeout'));
        });

        req2.on('error', (err) => {
          reject(err);
        });

        req2.end();
      });
    } catch (err) {
      console.error(`[IMG-PROXY] Error for ${url}:`, err.message);
      return reply.status(500).send('Image proxy error');
    }
  });
};

