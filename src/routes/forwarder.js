// API Forwarder routes for proxying external APIs

const https = require('https');
const http = require('http');
const { URL } = require('url');
const { ALLOWED_UPSTREAMS, BLOFIN_ALLOWED_HEADERS, BITUNIX_ALLOWED_HEADERS, POLYMARKET_ALLOWED_HEADERS, httpsAgent, httpAgent, UPSTREAM_TIMEOUT_MS } = require('../config/constants');
const { pickHeaders, buildUpstreamUrl } = require('../middleware/validation');
const storage = require('../services/storage');

const TICKER_CACHE_TTL = 300000; // 5m shared cache
const tickerCache = new Map(); // cacheKey -> { status, contentType, body, ts }
const pendingTickerFetches = new Map(); // cacheKey -> Promise

// Polymarket optimization cache (server-side)
const POLYMARKET_CACHE_TTL = 300000; // 5 minutes
const polymarketCache = new Map(); // cacheKey -> { status, contentType, body, ts }
const pendingPolymarketFetches = new Map(); // cacheKey -> Promise
const polymarketPollingIntervals = new Map(); // tagId -> intervalId

// Polymarket tag IDs to poll
const POLYMARKET_TAGS_TO_POLL = [
  { id: 21, label: 'crypto' },
  { id: 100328, label: 'economy' }
];

// Track active polls to prevent concurrent polling for same tag
const pollingInProgress = new Map(); // tagId -> true/false

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
  return false;
};

// Hyperliquid caching logic
const HYPERLIQUID_CACHE_TTL = 30000; // 30 seconds
const hyperliquidCache = new Map(); // bodyHash -> { status, contentType, body, ts }
const crypto = require('crypto');

const getHyperliquidCacheKey = (url, body) => {
  if (!body) return null;
  const hash = crypto.createHash('md5').update(body).digest('hex');
  return `hl:${url}:${hash}`;
};

const isHyperliquidCacheable = (url, body) => {
  if (!url.includes('api.hyperliquid.xyz/info')) return false;
  if (!body) return false;
  try {
    const parsed = JSON.parse(body);
    // Cache candle snapshots and metadata
    return parsed.type === 'candleSnapshot' || parsed.type === 'metaAndAssetCtxs' || parsed.type === 'allMids';
  } catch (_) {
    return false;
  }
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

    const cacheableTicker = method === 'GET' && isTickerEndpoint(parsedUrl);
    const hlCacheable = method === 'POST' && isHyperliquidCacheable(upstreamUrl, body);
    
    const cacheKey = cacheableTicker ? parsedUrl.toString() : (hlCacheable ? getHyperliquidCacheKey(upstreamUrl, body) : null);
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
      // console.log(`⚡ [FORWARDER] ${method} ${parsedUrl.pathname} -> ${res.status} (fetch: ${fetchTime}ms, total: ${totalTime}ms)`);
      
      // Track trade event
      try {
        let exchange = 'unknown';
        if (parsedUrl.hostname.includes('blofin')) exchange = 'blofin';
        else if (parsedUrl.hostname.includes('bitunix')) exchange = 'bitunix';
        else if (parsedUrl.hostname.includes('bybit')) exchange = 'bybit';
        
        let event = 'unknown';
        const path = parsedUrl.pathname.toLowerCase();
        if (path.includes('cancel')) event = 'cancel order';
        else if (path.includes('order')) event = 'open order'; // Could be open/close position
        
        // Try to refine event from body if available
        let payload = null;
        if (body) {
          try {
            payload = JSON.parse(body);
            if (payload.reduceOnly || payload.closeOnTrigger) {
              event = 'close position (order)';
            } else if (payload.side && payload.symbol) {
              event = 'open position (order)';
            }
          } catch (_) {
            payload = body;
          }
        }
        
        // Only track if we identified a relevant trade action
        if (exchange !== 'unknown') {
          storage.persistTradeEvent(exchange, event, {
            path: parsedUrl.pathname,
            status: res.status,
            request: payload,
            responseStatus: res.status
          });
        }
      } catch (err) {
        console.error('[FORWARDER] Failed to track trade event:', err);
      }
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

    if (cacheKey) {
      const activeCache = hlCacheable ? hyperliquidCache : tickerCache;
      const ttl = hlCacheable ? HYPERLIQUID_CACHE_TTL : TICKER_CACHE_TTL;
      
      const cached = activeCache.get(cacheKey);
      if (cached && Date.now() - cached.ts < ttl) {
        return sendResult(cached, 'HIT');
      }

      // Check for pending fetches to avoid duplicate requests (thundering herd)
      const activePending = hlCacheable ? pendingTickerFetches : pendingTickerFetches; // Use same map for now or separate? 
      // Actually tickerCache/hyperliquidCache are separate, but pendingTickerFetches is just a map.
      // I'll use separate pending maps for safety.
      
      // Wait, let's just use one pending map but key it correctly.
      if (pendingTickerFetches.has(cacheKey)) {
        const pendingResult = await pendingTickerFetches.get(cacheKey);
        if (pendingResult) {
          return sendResult(pendingResult, 'HIT');
        }
      }

      const execPromise = performRequest().then(result => {
        if (result.ok) {
          activeCache.set(cacheKey, {
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
  // Start Polymarket background polling
  startPolymarketPolling();
  
  // Stop polling on app termination
  app.addHook('onClose', () => {
    stopPolymarketPolling();
  });
  
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

  // Hyperliquid
  app.options('/api/hyperliquid/*', async (req, reply) => {
    setPreflightHeaders(reply, 'Content-Type', req.headers.origin);
    return reply.send();
  });
  app.route({
    method: ['GET', 'POST', 'PUT', 'DELETE'],
    url: '/api/hyperliquid/*',
    handler: async (req, reply) => {
      const suffix = req.params['*'] || '';
      const search = req.raw.url.includes('?') ? req.raw.url.slice(req.raw.url.indexOf('?')) : '';
      const upstream = buildUpstreamUrl('https://api.hyperliquid.xyz/', suffix, search);
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
      const rawSearch = req.raw.url.includes('?') ? req.raw.url.slice(req.raw.url.indexOf('?')) : '';
      const origin = req.headers.origin || '*';

      const isEvents = req.method === 'GET' && suffix.toLowerCase().startsWith('events');
      if (!isEvents) {
        // Non-events endpoints: just proxy as before
        const upstream = buildUpstreamUrl('https://gamma-api.polymarket.com/', suffix, rawSearch);
        return forwardRequest(upstream, req, reply, POLYMARKET_ALLOWED_HEADERS);
      }

      // Handle timeframe filtering on backend
      const timeframe = req.query?.timeframe || 'all';
      
      // Strip custom params that Gamma API doesn't understand
      let cleanSearch = rawSearch
        .replace(/[&?]timeframe=[^&]*/g, '')
        .replace(/[&?]orderBy=[^&]*/g, '');
      
      // Add proper Gamma API sorting to get newest markets first
      if (!cleanSearch.includes('order=')) {
        cleanSearch += (cleanSearch.includes('?') ? '&' : '?') + 'order=createdAt&ascending=false';
      }
      
      const upstream = buildUpstreamUrl('https://gamma-api.polymarket.com/', suffix, cleanSearch);
      const cacheKey = `${upstream.toString()}&_timeframe=${timeframe}`;

      // 1) Cache HIT
      const cached = polymarketCache.get(cacheKey);
      if (cached && Date.now() - cached.ts < POLYMARKET_CACHE_TTL) {
        // Removed spam log: console.log(`✅ [Polymarket] Cache HIT for ${suffix}`);
        reply.code(cached.status);
        reply.header('content-type', cached.contentType);
        reply.header('Access-Control-Allow-Origin', origin);
        reply.header('X-Polymarket-Cache', 'HIT');
        return reply.send(Buffer.from(cached.body));
      }

      // 2) In-flight request (dedup)
      if (pendingPolymarketFetches.has(cacheKey)) {
        // Removed spam log: console.log(`⏳ [Polymarket] Dedup - Waiting for in-flight request: ${suffix}`);
        const pendingResult = await pendingPolymarketFetches.get(cacheKey);
        reply.code(pendingResult.status);
        reply.header('content-type', pendingResult.contentType);
        reply.header('Access-Control-Allow-Origin', origin);
        reply.header('X-Polymarket-Cache', 'HIT');
        return reply.send(Buffer.from(pendingResult.body));
      }

      // 3) Fresh fetch from Gamma (fetch 300 markets, FE will filter)
      const startTime = Date.now();
      const execPromise = (async () => {
        const controller = new AbortController();
        const timeoutMs = Number(UPSTREAM_TIMEOUT_MS || 5000);
        const t = setTimeout(() => controller.abort(), timeoutMs);

        const parsedUrl = new URL(upstream);
        const agent = parsedUrl.protocol === 'https:' ? httpsAgent : httpAgent;

        // Fetch 300 markets for all requests - FE will handle filtering
        const fetchUrl = upstream.replace(/limit=\d+/, 'limit=300');

        try {
          const res = await fetch(fetchUrl, {
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
            
            // Just strip and return - FE handles filtering
            const stripped = stripPolymarketResponse(jsonData);
            const strippedJson = JSON.stringify(stripped);
            bodyBuf = Buffer.from(strippedJson, 'utf8');
            console.log(
              `✅ [Polymarket] MISS - Fetched ${Array.isArray(jsonData) ? jsonData.length : '?'} markets, stripped ${Math.round(rawBuf.length / 1024)}KB → ${Math.round(bodyBuf.length / 1024)}KB`
            );
          } catch (e) {
            console.warn('[Polymarket] Failed to process response:', e.message);
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
        // Removed spam log: console.log(`⏱️  [Polymarket] Request completed in ${totalTime}ms`);

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
};

// Start background polling for Polymarket tags
const startPolymarketPolling = () => {
  console.log('[Polymarket] Starting background polling for all tags...');
  
  POLYMARKET_TAGS_TO_POLL.forEach(tag => {
    // Poll every 5 minutes with concurrency guard
    const pollInterval = setInterval(async () => {
      // Skip if poll already in progress for this tag
      if (pollingInProgress.get(tag.id)) {
        console.warn(`[Polymarket] Poll already in progress for ${tag.label}, skipping...`);
        return;
      }
      
      pollingInProgress.set(tag.id, true);
      // Fetch top 250 by volume (sorted descending to get highest volume markets first)
      const url = `https://gamma-api.polymarket.com/events?closed=false&tag_id=${tag.id}&limit=250&order=volume&ascending=false`;
      
      try {
        const res = await fetch(url, {
          method: 'GET',
          headers: { 'User-Agent': 'clterminal-chats' },
          agent: httpsAgent
        });
        
        if (res.ok) {
          const data = await res.json();
          const stripped = stripPolymarketResponse(data);
          const strippedJson = JSON.stringify(stripped);
          const bodyBuf = Buffer.from(strippedJson, 'utf8');
          
          // Cache the result
          const cacheKey = `polymarket-${tag.id}`;
          polymarketCache.set(cacheKey, {
            status: 200,
            contentType: 'application/json',
            body: bodyBuf,
            ts: Date.now()
          });
          
          // Removed spam log: console.log(`[Polymarket] ✅ Polled ${tag.label} (tag ${tag.id}): ${data.length} markets`);
        } else {
          console.warn(`[Polymarket] Poll failed for ${tag.label}: ${res.status}`);
        }
      } catch (err) {
        console.error(`[Polymarket] Poll error for ${tag.label}:`, err.message);
      } finally {
        pollingInProgress.set(tag.id, false);
      }
    }, 300000); // 5 minutes
    
    polymarketPollingIntervals.set(tag.id, pollInterval);
  });
};

// Stop polling (for graceful shutdown)
const stopPolymarketPolling = () => {
  console.log('[Polymarket] Stopping background polling...');
  polymarketPollingIntervals.forEach((intervalId) => clearInterval(intervalId));
  polymarketPollingIntervals.clear();
};

