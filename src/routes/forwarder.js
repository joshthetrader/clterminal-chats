// API Forwarder routes for proxying external APIs

const https = require('https');
const http = require('http');
const { URL } = require('url');
const { ALLOWED_UPSTREAMS, BLOFIN_ALLOWED_HEADERS, BITUNIX_ALLOWED_HEADERS, POLYMARKET_ALLOWED_HEADERS, MEXC_ALLOWED_HEADERS, httpsAgent, httpAgent, UPSTREAM_TIMEOUT_MS } = require('../config/constants');
const { pickHeaders, buildUpstreamUrl } = require('../middleware/validation');

const TICKER_CACHE_TTL = 300000; // 5m shared cache
const tickerCache = new Map(); // cacheKey -> { status, contentType, body, ts }
const pendingTickerFetches = new Map(); // cacheKey -> Promise

// Polymarket optimization cache (server-side)
const POLYMARKET_CACHE_TTL = 300000; // 5 minutes
const polymarketCache = new Map(); // cacheKey -> { status, contentType, body, ts }
const pendingPolymarketFetches = new Map(); // cacheKey -> Promise

// Strip Polymarket /events response to only the fields required by the frontend parser.
// We keep just enough structure so the existing polymarketStore.js parseMarkets()
// continues to work without any changes.
const stripPolymarketResponse = (data) => {
  if (!Array.isArray(data)) return data;

  return data.map((event) => {
    const markets = Array.isArray(event.markets)
      ? event.markets.map((m) => ({
          id: m.id,
          conditionId: m.conditionId,
          question: m.question,
          groupItemTitle: m.groupItemTitle,
          // Frontend only needs these two to compute probabilities
          outcomes: m.outcomes,
          outcomePrices: m.outcomePrices,
          // For single-market path (SMP) where market = eventMarkets[0]
          endDate: m.endDate,
          endDateIso: m.endDateIso
        }))
      : [];

    return {
      id: event.id,
      title: event.title,
      // Used by GMP path: new Date(event.endDate || event.endDateIso)
      endDate: event.endDate,
      endDateIso: event.endDateIso,
      // Icon for display (fallback to image if present)
      icon: event.icon || event.image || null,
      volume: event.volume,
      markets
      // Everything else (description, tags, extra metadata) is intentionally stripped
    };
  });
};

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
  if (hostname === 'api.mexc.com' && pathname.includes('/ticker/24hr')) return true;
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

  // Polymarket with real optimizations (DTO + cache + dedup)
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
      const origin = req.headers.origin || '*';

      const isEvents = req.method === 'GET' && suffix.toLowerCase().startsWith('events');
      if (!isEvents) {
        // Non-events endpoints: just proxy as before
      return forwardRequest(upstream, req, reply, POLYMARKET_ALLOWED_HEADERS);
      }

      const cacheKey = upstream.toString();

      // 1) Cache HIT
      const cached = polymarketCache.get(cacheKey);
      if (cached && Date.now() - cached.ts < POLYMARKET_CACHE_TTL) {
        console.log(`✅ [Polymarket] Cache HIT for ${suffix}`);
        reply.code(cached.status);
        reply.header('content-type', cached.contentType);
        reply.header('Access-Control-Allow-Origin', origin);
        reply.header('X-Polymarket-Cache', 'HIT');
        return reply.send(Buffer.from(cached.body));
      }

      // 2) In-flight request (dedup)
      if (pendingPolymarketFetches.has(cacheKey)) {
        console.log(`⏳ [Polymarket] Dedup - Waiting for in-flight request: ${suffix}`);
        const pendingResult = await pendingPolymarketFetches.get(cacheKey);
        reply.code(pendingResult.status);
        reply.header('content-type', pendingResult.contentType);
        reply.header('Access-Control-Allow-Origin', origin);
        reply.header('X-Polymarket-Cache', 'HIT');
        return reply.send(Buffer.from(pendingResult.body));
      }

      // 3) Fresh fetch from Gamma
      const startTime = Date.now();
      const execPromise = (async () => {
        const controller = new AbortController();
        const timeoutMs = Number(UPSTREAM_TIMEOUT_MS || 5000);
        const t = setTimeout(() => controller.abort(), timeoutMs);

        const parsedUrl = new URL(upstream);
        const agent = parsedUrl.protocol === 'https:' ? httpsAgent : httpAgent;

        try {
          const res = await fetch(upstream, {
            method: 'GET',
            headers: { 'User-Agent': 'clterminal-chats' },
            signal: controller.signal,
            agent
          });

          clearTimeout(t);
          const rawBuf = Buffer.from(await res.arrayBuffer());
          let bodyBuf = rawBuf;

          try {
            const jsonData = JSON.parse(rawBuf.toString('utf8'));
            const stripped = stripPolymarketResponse(jsonData);
            const strippedJson = JSON.stringify(stripped);
            bodyBuf = Buffer.from(strippedJson, 'utf8');
            console.log(
              `✅ [Polymarket] MISS - Stripped ${Math.round(rawBuf.length / 1024)}KB → ${Math.round(bodyBuf.length / 1024)}KB`
            );
          } catch (e) {
            console.warn('[Polymarket] Failed to strip response, sending raw JSON:', e.message);
          }

          const result = {
            status: res.status,
            contentType: res.headers.get('content-type') || 'application/json',
            body: bodyBuf
          };

          if (res.ok) {
            polymarketCache.set(cacheKey, {
              ...result,
              ts: Date.now()
            });
          }

          return result;
        } catch (e) {
          console.error(`[Polymarket] Fetch failed:`, e?.message || e);
          throw e;
        } finally {
          pendingPolymarketFetches.delete(cacheKey);
        }
      })();

      pendingPolymarketFetches.set(cacheKey, execPromise);

      try {
        const result = await execPromise;
        const totalTime = Date.now() - startTime;
        console.log(`⏱️  [Polymarket] Request completed in ${totalTime}ms`);

        reply.code(result.status);
        reply.header('content-type', result.contentType);
        reply.header('Access-Control-Allow-Origin', origin);
        reply.header('X-Polymarket-Cache', 'MISS');
        return reply.send(Buffer.from(result.body));
      } catch (e) {
        reply.code(502);
        reply.header('Access-Control-Allow-Origin', origin);
        return reply.send({ error: 'Upstream error' });
      }
    }
  });

  // MEXC public API
  app.options('/api/mexc/*', async (req, reply) => {
    setPreflightHeaders(reply, 'Content-Type', req.headers.origin);
    return reply.send();
  });
  app.route({
    method: ['GET', 'POST', 'PUT', 'DELETE'],
    url: '/api/mexc/*',
    handler: async (req, reply) => {
      const suffix = req.params['*'] || '';
      const search = req.raw.url.includes('?') ? req.raw.url.slice(req.raw.url.indexOf('?')) : '';
      const upstream = buildUpstreamUrl('https://api.mexc.com/', suffix, search);
      return forwardRequest(upstream, req, reply, MEXC_ALLOWED_HEADERS);
    }
  });
};


