// API Forwarder routes for proxying external APIs

const https = require('https');
const http = require('http');
const { URL } = require('url');
const { ALLOWED_UPSTREAMS, BLOFIN_ALLOWED_HEADERS, BITUNIX_ALLOWED_HEADERS, POLYMARKET_ALLOWED_HEADERS, httpsAgent, httpAgent, UPSTREAM_TIMEOUT_MS } = require('../config/constants');
const { pickHeaders, buildUpstreamUrl } = require('../middleware/validation');

const TICKER_CACHE_TTL = 300000; // 5m shared cache
const tickerCache = new Map(); // cacheKey -> { status, contentType, body, ts }
const pendingTickerFetches = new Map(); // cacheKey -> Promise

const POLYMARKET_CACHE_TTL = 180000; // 3m cache for Polymarket data
const polymarketCache = new Map(); // cacheKey -> { status, contentType, body, ts }
const pendingPolymarketFetches = new Map(); // cacheKey -> Promise

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

const isPolymarketEndpoint = (parsedUrl) => {
  const hostname = parsedUrl.hostname;
  return hostname === 'gamma-api.polymarket.com';
};

// Strip unnecessary fields from Polymarket response to reduce payload size
function stripPolymarketResponse(data) {
  if (!Array.isArray(data)) return data;
  
  return data.map(event => ({
    id: event.id,
    slug: event.slug,
    title: event.title,
    description: event.description ? String(event.description).slice(0, 250) : '',
    endDate: event.endDate,
    endDateIso: event.endDateIso,
    icon: event.icon,
    image: event.image,
    markets: Array.isArray(event.markets) ? event.markets.map(m => ({
      id: m.id,
      question: m.question,
      icon: m.icon,
      image: m.image,
      outcomePrices: m.outcomePrices,
      outcomes: m.outcomes,
      volume: m.volume,
      clobTokenIds: m.clobTokenIds
    })) : [],
    volume: event.volume,
    liquidity: event.liquidity
  }));
}

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

    const isTickerRequest = method === 'GET' && isTickerEndpoint(parsedUrl);
    const isPolymarketRequest = method === 'GET' && isPolymarketEndpoint(parsedUrl);
    const cacheable = isTickerRequest || isPolymarketRequest;
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
      if (cacheHeader) {
        if (isPolymarketRequest) {
          reply.header('X-Polymarket-Cache', cacheHeader);
        } else {
          reply.header('X-Ticker-Cache', cacheHeader);
        }
      }
      return reply.send(Buffer.from(result.body));
    };

    if (cacheable && cacheKey) {
      // Select appropriate cache based on endpoint type
      const cache = isPolymarketRequest ? polymarketCache : tickerCache;
      const pendingFetches = isPolymarketRequest ? pendingPolymarketFetches : pendingTickerFetches;
      const cacheTTL = isPolymarketRequest ? POLYMARKET_CACHE_TTL : TICKER_CACHE_TTL;

      const cached = cache.get(cacheKey);
      if (cached && Date.now() - cached.ts < cacheTTL) {
        return sendResult(cached, 'HIT');
      }

      if (pendingFetches.has(cacheKey)) {
        const pendingResult = await pendingFetches.get(cacheKey);
        if (pendingResult) {
          return sendResult(pendingResult, 'HIT');
        }
      }

      const execPromise = performRequest().then(result => {
        if (result.ok) {
          let bodyToCache = result.body;
          
          // Strip Polymarket responses to reduce payload size
          if (isPolymarketRequest && result.contentType?.includes('application/json')) {
            try {
              const jsonData = JSON.parse(bodyToCache.toString());
              const stripped = stripPolymarketResponse(jsonData);
              bodyToCache = Buffer.from(JSON.stringify(stripped));
              result.body = bodyToCache; // Update result body too
            } catch (e) {
              fastify.log.warn('Failed to strip Polymarket response:', e.message);
            }
          }
          
          cache.set(cacheKey, {
            status: result.status,
            contentType: result.contentType,
            body: Buffer.from(bodyToCache),
            ts: Date.now()
          });
        }
        return result;
      }).finally(() => {
        pendingFetches.delete(cacheKey);
      });
      pendingFetches.set(cacheKey, execPromise);

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


// Warm up connections
const warmupConnections = () => {
  const hosts = ['https://openapi.blofin.com', 'https://fapi.bitunix.com'];
  hosts.forEach(host => {
    fetch(`${host}/`, { agent: httpsAgent }).catch(() => { });
  });
};

setTimeout(warmupConnections, 1000);

module.exports = function (app) {
  // Blofin
  app.options('/api/blofin/*', async (req, reply) => {
    setPreflightHeaders(reply, 'Content-Type, ACCESS-KEY, ACCESS-SIGN, ACCESS-TIMESTAMP, ACCESS-PASSPHRASE, ACCESS-NONCE, BROKER-ID', req.headers.origin);
    return reply.send();
  });
  app.route({
    method: ['GET', 'POST', 'PUT', 'DELETE'],
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
    method: ['GET', 'POST', 'PUT', 'DELETE'],
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
    method: ['GET', 'POST', 'PUT', 'DELETE'],
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
    method: ['GET', 'POST', 'PUT', 'DELETE'],
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
    method: ['GET', 'POST', 'PUT', 'DELETE'],
    url: '/api/polymarket/*',
    handler: async (req, reply) => {
      const suffix = req.params['*'] || '';
      const search = req.raw.url.includes('?') ? req.raw.url.slice(req.raw.url.indexOf('?')) : '';
      const upstream = buildUpstreamUrl('https://gamma-api.polymarket.com/', suffix, search);
      return forwardRequest(upstream, req, reply, POLYMARKET_ALLOWED_HEADERS);
    }
  });

  // Periodic cache cleanup to prevent memory growth
  setInterval(() => {
    const now = Date.now();
    
    // Clean ticker cache
    for (const [key, entry] of tickerCache.entries()) {
      if (now - entry.ts > TICKER_CACHE_TTL) {
        tickerCache.delete(key);
      }
    }
    
    // Clean Polymarket cache
    for (const [key, entry] of polymarketCache.entries()) {
      if (now - entry.ts > POLYMARKET_CACHE_TTL) {
        polymarketCache.delete(key);
    }
    }
  }, 60000); // Clean every minute
};


