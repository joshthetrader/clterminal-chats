'use strict';

// CORS Fix Deployment - 2025-10-07 13:56 UTC
// This deployment fixes CORS to allow Railway web app domain

const Fastify = require('fastify');
const fastifyCors = require('@fastify/cors');
const fastifyWebsocket = require('@fastify/websocket');
const { nanoid } = require('nanoid');
const { Client } = require('pg');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
// Protect optional read endpoints (disabled by default)
const ENABLE_TRADE_EVENTS_READ = String(process.env.ENABLE_TRADE_EVENTS_READ || 'false').toLowerCase() === 'true';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

// Allow multiple origins for CORS
const getAllowedOrigins = () => {
  const envOrigin = process.env.CORS_ORIGIN;
  if (envOrigin) {
    return envOrigin.split(',').map(origin => origin.trim());
  }
  
  // Default allowed origins
  return [
    'http://127.0.0.1:3000',
    'http://localhost:3000',
    'http://127.0.0.1:3001',
    'http://localhost:3001',
    'http://127.0.0.1:3002',
    'http://localhost:3002',
    'http://127.0.0.1:3003',
    'http://localhost:3003',
    'http://127.0.0.1:8080',
    'http://localhost:8080',
    'https://cryptolegendsweb-production.up.railway.app',
    'https://cryptolegendsweb.vercel.app',
    'https://www.cryptolegendsterminal.com'
  ];
};

// Rate limiting per connection
const rateLimits = new Map(); // connectionId -> { count, resetTime }

// Postgres connection (optional in dev). If not configured, fall back to in-memory.
const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
let pgClient = null;

// In-memory message store for development (when no database)
let memoryMessages = [];
let memoryNews = [];
let memoryVolatilityAlerts = [];

// File-based persistence for development
const fs = require('fs');
const path = require('path');
const MESSAGES_FILE = path.join(__dirname, '..', 'data', 'messages.json');
const NEWS_FILE = path.join(__dirname, '..', 'data', 'news.json');

// Load messages from file on startup
function loadMessages() {
  try {
    if (fs.existsSync(MESSAGES_FILE)) {
      const data = fs.readFileSync(MESSAGES_FILE, 'utf8');
      memoryMessages = JSON.parse(data) || [];
      console.log(`[Storage] Loaded ${memoryMessages.length} messages from file`);
    } else {
      // Create data directory if it doesn't exist
      const dataDir = path.dirname(MESSAGES_FILE);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
    }
  } catch (e) {
    console.error('[Storage] Failed to load messages:', e.message);
    memoryMessages = [];
  }
}

function loadNews() {
  try {
    if (fs.existsSync(NEWS_FILE)) {
      const data = fs.readFileSync(NEWS_FILE, 'utf8');
      memoryNews = JSON.parse(data) || [];
      console.log(`[Storage] Loaded ${memoryNews.length} news items from file`);
    } else {
      const dataDir = path.dirname(NEWS_FILE);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
    }
  } catch (e) {
    console.error('[Storage] Failed to load news:', e.message);
    memoryNews = [];
  }
}

// Save messages to file
function saveMessages() {
  try {
    const dataDir = path.dirname(MESSAGES_FILE);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    fs.writeFileSync(MESSAGES_FILE, JSON.stringify(memoryMessages, null, 2));
  } catch (e) {
    console.error('[Storage] Failed to save messages:', e.message);
  }
}

function saveNews() {
  try {
    const dataDir = path.dirname(NEWS_FILE);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    fs.writeFileSync(NEWS_FILE, JSON.stringify(memoryNews, null, 2));
  } catch (e) {
    console.error('[Storage] Failed to save news:', e.message);
  }
}

// Track active connections per room
const activeConnections = new Map(); // room -> Set(connectionId)

async function initPostgres() {
  if (!DATABASE_URL) return;
  pgClient = new Client({ connectionString: DATABASE_URL, ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : undefined });
  await pgClient.connect();
  await pgClient.query(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      room TEXT NOT NULL,
      user_name TEXT NOT NULL,
      user_color TEXT,
      text TEXT,
      is_trade BOOLEAN DEFAULT FALSE,
      trade_sym TEXT,
      trade_side TEXT,
      trade_lev TEXT,
      trade_entry TEXT,
      reply_to TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS chat_messages_room_created_at ON chat_messages(room, created_at DESC);

    -- Separate storage for news items
    CREATE TABLE IF NOT EXISTS news_items (
      id TEXT PRIMARY KEY,
      source_name TEXT,
      source_username TEXT,
      text TEXT,
      url TEXT,
      followers BIGINT,
      images JSONB,
      coin TEXT,
      symbols JSONB,
      is_retweet BOOLEAN DEFAULT FALSE,
      is_quote BOOLEAN DEFAULT FALSE,
      is_reply BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      received_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS news_items_created_at ON news_items(created_at DESC);

    -- Volatility Alerts storage
    CREATE TABLE IF NOT EXISTS volatility_alerts (
      id TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      exchange TEXT NOT NULL,
      price NUMERIC,
      change_percent NUMERIC,
      volume NUMERIC,
      alert_type TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS volatility_alerts_created_at ON volatility_alerts(created_at DESC);

    -- Trading: orders, fills, events (no secrets)
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      client_order_id TEXT,
      exchange TEXT NOT NULL,
      symbol TEXT NOT NULL,
      side TEXT,
      type TEXT,
      price NUMERIC,
      qty NUMERIC,
      status TEXT,
      client_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_orders_client ON orders(client_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS fills (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      exchange TEXT NOT NULL,
      symbol TEXT NOT NULL,
      price NUMERIC NOT NULL,
      qty NUMERIC NOT NULL,
      fee NUMERIC,
      liquidity TEXT,
      ts TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_fills_order ON fills(order_id, ts DESC);

    CREATE TABLE IF NOT EXISTS order_events (
      id TEXT PRIMARY KEY,
      order_id TEXT REFERENCES orders(id) ON DELETE CASCADE,
      exchange TEXT NOT NULL,
      type TEXT NOT NULL,
      payload JSONB,
      ts TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Online migration: ensure client_id exists on chat_messages for persistence
  await pgClient.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS client_id TEXT`);
  // Online migrations for news_items extras
  await pgClient.query(`ALTER TABLE news_items ADD COLUMN IF NOT EXISTS coin TEXT`);
  await pgClient.query(`ALTER TABLE news_items ADD COLUMN IF NOT EXISTS symbols JSONB`);
}

const app = Fastify({ logger: true });

// CORS configuration - pass function to be called on each request
// Register WebSocket plugin BEFORE CORS to ensure proper upgrade handling
app.register(fastifyWebsocket);

app.register(fastifyCors, {
  origin: (origin, callback) => {
    const allowed = getAllowedOrigins();
    console.log(`[CORS] Request from: ${origin}, Allowed: ${JSON.stringify(allowed)}`);
    
    // Allow requests with no origin (like curl, Postman, or same-origin)
    if (!origin) {
      callback(null, true);
      return;
    }
    
    // Check if origin is in allowed list
    if (allowed.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'), false);
    }
  },
  credentials: true 
});

// Minimal health and version endpoints
app.get('/health', async () => ({ ok: true }));

// Clear all messages (admin endpoint)
app.delete('/api/messages/clear', async (request, reply) => {
  try {
    if (pgClient) {
      await pgClient.query('DELETE FROM messages');
      console.log('[Postgres] Cleared all messages');
    } else {
      memoryMessages.length = 0;
      saveMessages();
      console.log('[Memory] Cleared all messages');
    }
    return { ok: true, message: 'All messages cleared' };
  } catch (error) {
    console.error('[Clear] Error:', error);
    return reply.code(500).send({ error: 'Failed to clear messages' });
  }
});
app.get('/version', async () => ({ name: 'crypto-legends-chat-server', version: '0.1.0' }));

// Trade events endpoint (client-emit) - store minimal metadata, no secrets
app.post('/api/trade-events', async (request, reply) => {
  try {
    const body = request.body || {};
    const type = String(body.type || '').toUpperCase();
    const exchange = String(body.exchange || '').toLowerCase();
    const clientId = body.clientId ? String(body.clientId).slice(0, 64) : null;
    if (!type || !exchange) return reply.code(400).send({ error: 'type and exchange required' });

    // Normalize supported types: ORDER_NEW, ORDER_UPDATE, FILL, EVENT
    if (type === 'ORDER_NEW' && body.order) {
      const o = body.order;
      const orderId = String(o.id || o.orderId || '').slice(0, 100);
      if (!orderId) return reply.code(400).send({ error: 'order.id required' });
      if (pgClient) {
        await pgClient.query(
          `INSERT INTO orders (id, client_order_id, exchange, symbol, side, type, price, qty, status, client_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, updated_at = NOW()`,
          [
            orderId,
            o.clientOrderId || null,
            exchange,
            (o.symbol || o.instId || '').toUpperCase(),
            o.side || null,
            o.type || null,
            o.price != null ? Number(o.price) : null,
            o.qty != null ? Number(o.qty) : null,
            o.status || null,
            clientId
          ]
        );
      }
      return { ok: true };
    }

    if (type === 'FILL' && body.fill) {
      const f = body.fill;
      const fillId = String(f.id || f.tradeId || '').slice(0, 120);
      const orderId = String(f.orderId || '').slice(0, 100);
      if (!fillId || !orderId) return reply.code(400).send({ error: 'fill.id and fill.orderId required' });
      if (pgClient) {
        await pgClient.query(
          `INSERT INTO fills (id, order_id, exchange, symbol, price, qty, fee, liquidity, ts)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TO_TIMESTAMP($9/1000.0))
           ON CONFLICT (id) DO NOTHING`,
          [
            fillId,
            orderId,
            exchange,
            (f.symbol || '').toUpperCase(),
            Number(f.price),
            Number(f.qty),
            f.fee != null ? Number(f.fee) : null,
            f.liquidity || null,
            Number(f.ts || Date.now())
          ]
        );
      }
      return { ok: true };
    }

    // Generic event capture
    const eventId = String(body.id || nanoid()).slice(0, 120);
    const orderId = body.orderId ? String(body.orderId).slice(0, 100) : null;
    if (pgClient) {
      await pgClient.query(
        `INSERT INTO order_events (id, order_id, exchange, type, payload)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING`,
        [eventId, orderId, exchange, type, JSON.stringify(body.payload || body)]
      );
    }
    return { ok: true };
  } catch (e) {
    app.log.error(e, 'trade-events error');
    return reply.code(500).send({ error: 'failed' });
  }
});

// Get recent trade events
app.get('/api/trade-events', async (request, reply) => {
  try {
    // Guard: disable by default unless explicitly enabled via env
    if (!ENABLE_TRADE_EVENTS_READ) {
      return reply.code(404).send({ error: 'not_found' });
    }
    // Require admin token
    const hdr = request.headers || {};
    const bearer = typeof hdr['authorization'] === 'string' ? hdr['authorization'].replace(/^Bearer\s+/i, '') : '';
    const token = hdr['x-admin-token'] || hdr['x-adminkey'] || bearer || '';
    if (!ADMIN_TOKEN || String(token) !== String(ADMIN_TOKEN)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }

    const limit = Math.min(Number(request.query.limit) || 100, 500);
    const exchange = request.query.exchange ? String(request.query.exchange).toLowerCase() : null;
    
    if (!pgClient) {
      return { orders: [], fills: [], events: [] };
    }
    
    // Fetch recent orders
    let ordersQuery = `
      SELECT id, client_order_id, exchange, symbol, side, type, price, qty, status, 
             EXTRACT(EPOCH FROM created_at) * 1000 as ts
      FROM orders
    `;
    const ordersParams = [];
    if (exchange) {
      ordersQuery += ` WHERE exchange = $1`;
      ordersParams.push(exchange);
    }
    ordersQuery += ` ORDER BY created_at DESC LIMIT $${ordersParams.length + 1}`;
    ordersParams.push(limit);
    
    const ordersResult = await pgClient.query(ordersQuery, ordersParams);
    const orders = ordersResult.rows.map(row => ({
      id: row.id,
      clientOrderId: row.client_order_id,
      exchange: row.exchange,
      symbol: row.symbol,
      side: row.side,
      type: row.type,
      price: row.price ? Number(row.price) : null,
      qty: row.qty ? Number(row.qty) : null,
      status: row.status,
      ts: Number(row.ts)
    }));
    
    // Fetch recent fills
    let fillsQuery = `
      SELECT id, order_id, exchange, symbol, price, qty, fee, liquidity,
             EXTRACT(EPOCH FROM ts) * 1000 as ts
      FROM fills
    `;
    const fillsParams = [];
    if (exchange) {
      fillsQuery += ` WHERE exchange = $1`;
      fillsParams.push(exchange);
    }
    fillsQuery += ` ORDER BY ts DESC LIMIT $${fillsParams.length + 1}`;
    fillsParams.push(limit);
    
    const fillsResult = await pgClient.query(fillsQuery, fillsParams);
    const fills = fillsResult.rows.map(row => ({
      id: row.id,
      orderId: row.order_id,
      exchange: row.exchange,
      symbol: row.symbol,
      price: Number(row.price),
      qty: Number(row.qty),
      fee: row.fee ? Number(row.fee) : null,
      liquidity: row.liquidity,
      ts: Number(row.ts)
    }));
    
    // Fetch recent events
    let eventsQuery = `
      SELECT id, order_id, exchange, type, payload,
             EXTRACT(EPOCH FROM ts) * 1000 as ts
      FROM order_events
    `;
    const eventsParams = [];
    if (exchange) {
      eventsQuery += ` WHERE exchange = $1`;
      eventsParams.push(exchange);
    }
    eventsQuery += ` ORDER BY ts DESC LIMIT $${eventsParams.length + 1}`;
    eventsParams.push(limit);
    
    const eventsResult = await pgClient.query(eventsQuery, eventsParams);
    const events = eventsResult.rows.map(row => ({
      id: row.id,
      orderId: row.order_id,
      exchange: row.exchange,
      type: row.type,
      payload: row.payload,
      ts: Number(row.ts)
    }));
    
    return { orders, fills, events };
  } catch (e) {
    app.log.error(e, 'Failed to fetch trade events');
    return { orders: [], fills: [], events: [] };
  }
});

// =====================
// Stateless Forwarders (Optimized)
// =====================
const ALLOWED_UPSTREAMS = new Set([
  'openapi.blofin.com',
  'fapi.bitunix.com',
  'api.bitunix.com'
]);

const BLOFIN_ALLOWED_HEADERS = new Set([
  'access-key','access-sign','access-timestamp','access-passphrase','access-nonce','broker-id','content-type'
]);
const BITUNIX_ALLOWED_HEADERS = new Set([
  'api-key','sign','timestamp','nonce','content-type'
]);

// HTTP Agent with connection pooling for faster requests
const http = require('http');
const https = require('https');

const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000, // Keep connections alive for 30s
  maxSockets: 100, // Allow up to 100 concurrent connections per host
  maxFreeSockets: 10, // Keep 10 idle connections ready
  timeout: 5000, // Socket timeout
  scheduling: 'fifo', // First in, first out (better for latency)
  // DNS caching (node 18+)
  lookup: undefined // Use default DNS with OS-level caching
});

const httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 100,
  maxFreeSockets: 10,
  timeout: 5000,
  scheduling: 'fifo'
});

// Warm up connections to frequently used hosts
const warmupConnections = () => {
  const hosts = ['https://openapi.blofin.com', 'https://fapi.bitunix.com'];
  hosts.forEach(host => {
    fetch(`${host}/`, { agent: httpsAgent }).catch(() => {}); // Ignore errors, just warm up
  });
};

// Warm up after server starts
setTimeout(warmupConnections, 1000);

function pickHeaders(headers, allowSet) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const key = String(k).toLowerCase();
    if (allowSet.has(key)) out[k] = v;
  }
  return out;
}

function buildUpstreamUrl(base, suffix, search) {
  const path = String(suffix || '').replace(/^\//, '');
  const qs = search ? String(search) : '';
  return `${base}${path}${qs}`;
}

async function forwardRequest(upstreamUrl, req, reply, allowedHeaderSet) {
  const startTime = Date.now();
  try {
    // Security: ensure host is allowed
    try {
      const u = new URL(upstreamUrl);
      if (!ALLOWED_UPSTREAMS.has(u.hostname)) {
        return reply.code(400).send({ error: 'Upstream not allowed' });
      }
    } catch (_) {
      return reply.code(400).send({ error: 'Invalid upstream URL' });
    }

    // Build headers
    const incoming = req.headers || {};
    const sanitized = pickHeaders(incoming, allowedHeaderSet);
    // Never forward cookies or origin headers
    delete sanitized['cookie'];
    delete sanitized['origin'];
    delete sanitized['referer'];

    const controller = new AbortController();
    // Reduced timeout for faster failure detection (trade execution speed)
    const timeoutMs = Number(process.env.UPSTREAM_TIMEOUT_MS || 5000);
    const t = setTimeout(() => controller.abort(), timeoutMs);
    const method = (req.method || 'GET').toUpperCase();

    // Body handling
    let body = undefined;
    if (method !== 'GET' && method !== 'HEAD') {
      // Fastify has already parsed the body if content-type is application/json
      // We need to stringify it back for fetch()
      if (req.body && typeof req.body === 'object') {
        body = JSON.stringify(req.body);
      } else if (req.body) {
        body = String(req.body);
      }
    }

    // Use connection pooling agent for faster requests
    const parsedUrl = new URL(upstreamUrl);
    const agent = parsedUrl.protocol === 'https:' ? httpsAgent : httpAgent;

    const fetchStart = Date.now();
    const res = await fetch(upstreamUrl, {
      method,
      headers: sanitized,
      body,
      signal: controller.signal,
      agent // Connection pooling for reuse
    }).catch((e) => {
      throw e;
    });
    clearTimeout(t);
    
    const fetchTime = Date.now() - fetchStart;
    const totalTime = Date.now() - startTime;
    
    // Log performance for trade endpoints (POST requests)
    if (method === 'POST' && (upstreamUrl.includes('/trade/') || upstreamUrl.includes('/order'))) {
      console.log(`⚡ [FORWARDER] ${method} ${parsedUrl.pathname} -> ${res.status} (fetch: ${fetchTime}ms, total: ${totalTime}ms)`);
    }

    // Mirror status and content-type
    reply.code(res.status);
    // Copy selected response headers
    const resCt = res.headers.get('content-type');
    if (resCt) reply.header('content-type', resCt);

    // Stream back
    const buf = Buffer.from(await res.arrayBuffer());
    return reply.send(buf);
  } catch (e) {
    const code = e?.name === 'AbortError' ? 504 : 502;
    return reply.code(code).send({ error: 'Upstream error' });
  }
}

// Preflight helpers
function setPreflightHeaders(reply, allowHeaders) {
  reply.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  reply.header('Access-Control-Allow-Headers', allowHeaders);
  reply.header('Access-Control-Max-Age', '600');
}

// Blofin forwarder
app.options('/api/blofin/*', async (req, reply) => {
  setPreflightHeaders(reply, 'Content-Type, ACCESS-KEY, ACCESS-SIGN, ACCESS-TIMESTAMP, ACCESS-PASSPHRASE, ACCESS-NONCE, BROKER-ID');
  return reply.send();
});
app.route({
  method: ['GET','POST','PUT','DELETE'],
  url: '/api/blofin/*',
  handler: async (req, reply) => {
    const suffix = req.params['*'] || '';
    // Accept both '/api/blofin/api/v1/...' (preferred) and '/api/blofin/v1/...'
    // Ensure upstream path always begins with 'api/' (Blofin requires '/api/v1/...')
    let normalized = String(suffix).replace(/^\/+/, '');
    if (!normalized.startsWith('api/')) {
      normalized = `api/${normalized}`;
    }
    const search = req.raw.url.includes('?') ? req.raw.url.slice(req.raw.url.indexOf('?')) : '';
    const upstream = buildUpstreamUrl('https://openapi.blofin.com/', normalized, search);
    return forwardRequest(upstream, req, reply, BLOFIN_ALLOWED_HEADERS);
  }
});

// Bitunix forwarder (public)
app.options('/api/bitunix/*', async (req, reply) => {
  setPreflightHeaders(reply, 'Content-Type');
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

// Bitunix forwarder (private)
app.options('/api/bitunix-private/*', async (req, reply) => {
  setPreflightHeaders(reply, 'Content-Type, api-key, sign, timestamp, nonce');
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

// Bitunix alt host (api.bitunix.com)
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

// -------------------------
// WebSocket forwarders
// -------------------------

function wsPipe(client, upstreamUrl) {
  console.log(`[WS-Forwarder] 🔌 Client connected, establishing upstream connection to: ${upstreamUrl}`);
  console.log(`[WS-Forwarder] 🔍 Client object type: ${typeof client}, has readyState: ${client.readyState !== undefined}, readyState: ${client.readyState}`);
  
  if (!client || typeof client.on !== 'function') {
    console.error(`[WS-Forwarder] ❌ Invalid client object - missing 'on' method`);
    return;
  }
  
  let upstreamConnected = false;
  let clientClosed = false;
  
  console.log(`[WS-Forwarder] 🔌 Creating upstream WebSocket to: ${upstreamUrl}`);
  const upstream = new WebSocket(upstreamUrl, { 
    rejectUnauthorized: true,
    handshakeTimeout: 10000
  });
  console.log(`[WS-Forwarder] 🔌 Upstream WebSocket created, readyState: ${upstream.readyState}`);
  
  const closeBoth = (code = 1000, reason = 'closing') => {
    console.log(`[WS-Proxy] 🔌 Closing connections: ${reason} (code: ${code})`);
    try { 
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
        upstream.close(code, reason); 
      }
    } catch(e) { 
      console.error(`[WS-Proxy] Error closing upstream:`, e.message); 
    }
    try { 
      if (!clientClosed && (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING)) {
        client.close(code, reason); 
      }
    } catch(e) { 
      console.error(`[WS-Proxy] Error closing client:`, e.message); 
    }
  };
  
  // Set up client message forwarding (register early)
  client.on('message', (msg) => {
    if (!upstreamConnected) {
      console.log(`[WS-Proxy] ⚠️ Client sent message before upstream connected, buffering...`);
      // Buffer or drop - for now we'll just log
      return;
    }
    try { 
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(msg); 
        console.log(`[WS-Proxy] 📤 Forwarded client->upstream: ${msg.toString().substring(0, 100)}`);
      }
    } catch(e) { 
      console.error(`[WS-Proxy] ❌ Error sending to upstream:`, e.message); 
    } 
  });
  
  // Set up upstream connection
  upstream.on('open', () => {
    upstreamConnected = true;
    console.log(`[WS-Forwarder] ✅ Upstream connected: ${upstreamUrl}`);
    
    // Now set up upstream message forwarding
    upstream.on('message', (msg) => { 
      console.log(`[WS-Forwarder] 📬 Received from upstream: ${msg.toString().substring(0, 100)}`);
      try { 
        const clientState = client.readyState === 1 ? 'OPEN' : client.readyState === 0 ? 'CONNECTING' : client.readyState === 2 ? 'CLOSING' : 'CLOSED';
        console.log(`[WS-Forwarder] Client state: ${clientState} (${client.readyState}), clientClosed: ${clientClosed}`);
        
        if (!clientClosed && client.readyState === 1) {
          client.send(msg); 
          console.log(`[WS-Forwarder] ✅ Forwarded upstream->client successfully`);
        } else {
          console.warn(`[WS-Forwarder] ⚠️ Skipped forwarding - client not ready`);
        }
      } catch(e) { 
        console.error(`[WS-Forwarder] ❌ Error sending to client:`, e.message); 
      } 
    });
  });
  
  upstream.on('error', (err) => {
    console.error(`[WS-Forwarder] ❌ Upstream error for ${upstreamUrl}:`, err.message || err);
    if (!upstreamConnected) {
      console.error(`[WS-Forwarder] ❌ Failed to establish upstream connection`);
    }
    closeBoth(1011, 'upstream error');
  });
  
  client.on('error', (err) => {
    console.error(`[WS-Forwarder] ❌ Client error:`, err.message || err);
    closeBoth(1011, 'client error');
  });
  
  upstream.on('close', (code, reason) => {
    console.log(`[WS-Forwarder] 🔌 Upstream closed: ${upstreamUrl} (${code}: ${reason})`);
    upstreamConnected = false;
    closeBoth(code, 'upstream closed');
  });
  
  client.on('close', (code, reason) => {
    console.log(`[WS-Forwarder] 🔌 Client closed (${code}: ${reason})`);
    clientClosed = true;
    closeBoth(code, 'client closed');
  });
}

// Blofin public WS → /ws-blofin-public
app.get('/ws-blofin-public', { websocket: true }, (connection /* SocketStream */, req) => {
  wsPipe(connection.socket, 'wss://openapi.blofin.com/ws/public');
});

// Blofin private WS → /ws-blofin-private
app.get('/ws-blofin-private', { websocket: true }, (connection, req) => {
  wsPipe(connection.socket, 'wss://openapi.blofin.com/ws/private');
});

// Bitunix public WS → /ws-bitunix-public
app.get('/ws-bitunix-public', { websocket: true }, (connection, req) => {
  wsPipe(connection.socket, 'wss://fapi.bitunix.com/public/');
});

// Bitunix private WS → /ws-bitunix-private
app.get('/ws-bitunix-private', { websocket: true }, (connection, req) => {
  wsPipe(connection.socket, 'wss://fapi.bitunix.com/private/');
});

// News: fetch last N items
app.get('/api/news', async (request, reply) => {
  const limit = Math.min(Number(request.query.limit) || 100, 200);
  try {
    if (pgClient) {
      // Prefer DB results if available
      const result = await pgClient.query(
        `SELECT id, source_name, source_username, text, url, followers, images, coin, symbols, is_retweet, is_quote, is_reply,
                EXTRACT(EPOCH FROM created_at) * 1000 as created_ms,
                EXTRACT(EPOCH FROM COALESCE(received_at, created_at)) * 1000 as received_ms
         FROM news_items
         ORDER BY created_at DESC
         LIMIT $1`,
        [limit]
      );
      const items = (result.rows || []).map(r => ({
        id: r.id,
        name: r.source_name,
        username: r.source_username,
        text: r.text,
        url: r.url,
        followers: Number(r.followers || 0),
        images: Array.isArray(r.images) ? r.images : (typeof r.images === 'string' ? JSON.parse(r.images) : []),
        coin: r.coin || null,
        symbols: Array.isArray(r.symbols) ? r.symbols : (typeof r.symbols === 'string' ? JSON.parse(r.symbols) : []),
        isRetweet: !!r.is_retweet,
        isQuote: !!r.is_quote,
        isReply: !!r.is_reply,
        createdAt: Number(r.created_ms) || Date.now(),
        receivedAt: Number(r.received_ms) || Number(r.created_ms) || Date.now()
      })).reverse();
      return { items };
    }
    const items = memoryNews.slice(-limit).reverse();
    return { items };
  } catch (e) {
    app.log.error(e, 'Failed to fetch news');
    return { items: [] };
  }
});

// Get recent chat history
app.get('/api/messages/:room', async (request, reply) => {
  const room = String(request.params.room || 'global');
  const limit = Math.min(Number(request.query.limit) || 50, 100);
  
  try {
    if (pgClient) {
      // Use Postgres
      const result = await pgClient.query(
        `SELECT id, user_name, user_color, text, is_trade, trade_sym, trade_side, trade_lev, trade_entry, reply_to, 
                EXTRACT(EPOCH FROM created_at) * 1000 as ts
         FROM chat_messages 
         WHERE room = $1 
         ORDER BY created_at DESC 
         LIMIT $2`,
        [room, limit]
      );
      
      const messages = result.rows.reverse().map(row => ({
        type: 'message',
        id: row.id,
        room,
        user: { name: row.user_name, color: row.user_color },
        ts: Number(row.ts),
        text: row.text,
        tradeShare: row.is_trade,
        share: row.is_trade ? {
          sym: row.trade_sym,
          side: row.trade_side,
          lev: row.trade_lev,
          entry: row.trade_entry
        } : undefined,
        replyTo: row.reply_to
      }));
      
      return { messages };
    } else {
      // Use in-memory store
      const roomMessages = memoryMessages
        .filter(m => m.room === room)
        .slice(-limit)
        .map(m => ({
          type: 'message',
          id: m.id,
          room: m.room,
          user: { name: m.user_name, color: m.user_color },
          ts: m.ts,
          text: m.text,
          tradeShare: m.is_trade,
          share: m.is_trade ? {
            sym: m.trade_sym,
            side: m.trade_side,
            lev: m.trade_lev,
            entry: m.trade_entry
          } : undefined,
          replyTo: m.reply_to,
          clientId: m.client_id
        }));
      
      return { messages: roomMessages };
    }
  } catch (e) {
    app.log.error(e, 'Failed to fetch messages');
    return { messages: [] };
  }
});

// Upgrade: ws endpoint for chat
// Protocol: messages are JSON with type fields
// { type: 'hello', user: { name, color }, room?: 'global' }
// { type: 'chat', text, replyTo? }
// { type: 'share', sym, side, lev, entry }
// Server broadcasts: 'welcome', 'message', 'presence'

const rooms = new Map(); // room -> Set(ws)
const newsClients = new Set(); // connected ws clients for news
const volatilityClients = new Set(); // connected ws clients for volatility alerts

function broadcast(room, payload) {
  const set = rooms.get(room);
  if (!set) return;
  const data = JSON.stringify(payload);
  for (const ws of set) {
    try { ws.send(data); } catch (_) {}
  }
}

function broadcastPresence(room) {
  const count = activeConnections.get(room)?.size || 0;
  broadcast(room, { type: 'presence', room, count });
}

// Enhanced input sanitization
function sanitizeInput(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/[<>]/g, '') // Remove potential HTML tags
    .replace(/javascript:/gi, '') // Remove javascript: protocol
    .replace(/on\w+=/gi, '') // Remove event handlers
    .trim()
    .slice(0, 100);
}

function sanitizeName(name) {
  if (!name || typeof name !== 'string') return 'Anon';
  return name
    .replace(/[<>]/g, '')
    .replace(/javascript:/gi, '')
    .replace(/on\w+=/gi, '')
    .trim()
    .slice(0, 20) || 'Anon';
}

// Rate limiting check
function checkRateLimit(connectionId) {
  const now = Date.now();
  const limit = rateLimits.get(connectionId);
  
  if (!limit || now > limit.resetTime) {
    rateLimits.set(connectionId, { count: 1, resetTime: now + 60000 }); // 1 minute window
    return true;
  }
  
  if (limit.count >= 30) { // Max 30 messages per minute
    return false;
  }
  
  limit.count++;
  return true;
}

async function persistMessage(msg) {
  const {
    id, room, user_name, user_color, text,
    is_trade, trade_sym, trade_side, trade_lev, trade_entry, reply_to, client_id
  } = msg;
  
  if (pgClient) {
    // Use Postgres
    try {
      await pgClient.query(
        `INSERT INTO chat_messages (id, room, user_name, user_color, text, is_trade, trade_sym, trade_side, trade_lev, trade_entry, reply_to, client_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (id) DO NOTHING`,
        [id, room, user_name, user_color, text || null, !!is_trade, trade_sym || null, trade_side || null, trade_lev || null, trade_entry || null, reply_to || null, client_id || null]
      );
    } catch (e) {
      app.log.error(e, 'persistMessage error');
    }
  } else {
    // Use in-memory store (keep last 1000 messages)
    const memMsg = {
      id, room, user_name, user_color, text: text || null,
      is_trade: !!is_trade, trade_sym: trade_sym || null, trade_side: trade_side || null,
      trade_lev: trade_lev || null, trade_entry: trade_entry || null, reply_to: reply_to || null,
      client_id: client_id || null, ts: Date.now()
    };
    
    memoryMessages.push(memMsg);
    
    // Keep only last 1000 messages
    if (memoryMessages.length > 1000) {
      memoryMessages = memoryMessages.slice(-1000);
    }
    
    // Save to file after each message
    saveMessages();
    
    console.log(`[Memory] Stored message, total: ${memoryMessages.length}`);
  }
}

// WebSocket routes must be registered after the websocket plugin
app.register(async function (fastify) {
  // Add a simple test route to verify websocket plugin is working
  fastify.get('/ws-test', async (request, reply) => {
    return { websocketSupported: !!fastify.websocketServer };
  });
  
  fastify.get('/ws', { websocket: true }, (connection, req) => {
    const ws = connection.socket;
    let user = { name: 'Anon', color: '#aaa' };
    let clientId = null;
    const room = 'global';
    const connectionId = Math.random().toString(36).slice(2);

    console.log('WebSocket connection established:', connectionId);

    if (!rooms.has(room)) rooms.set(room, new Set());
    rooms.get(room).add(ws);
    
    if (!activeConnections.has(room)) activeConnections.set(room, new Set());
    activeConnections.get(room).add(connectionId);

    // Send initial presence
    broadcastPresence(room);

  ws.on('message', async (raw) => {
    console.log('WebSocket message received:', String(raw));
    let msg = null;
    try { msg = JSON.parse(String(raw)); } catch (_) {}
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'hello') {
      user = {
        name: sanitizeName(msg?.user?.name),
        color: String(msg?.user?.color || '#aaa').match(/^#[0-9A-Fa-f]{6}$/) ? msg.user.color : '#aaa'
      };
      clientId = msg.clientId ? String(msg.clientId).slice(0, 40) : null;
      console.log('User connected:', user, 'clientId:', clientId);
      ws.send(JSON.stringify({ type: 'welcome', room, user }));
      broadcastPresence(room);
      return;
    }

    if (msg.type === 'chat') {
      // Rate limiting check
      if (!checkRateLimit(connectionId)) {
        ws.send(JSON.stringify({ type: 'error', message: 'Rate limit exceeded' }));
        return;
      }
      
      const sanitizedText = sanitizeInput(msg.text);
      if (!sanitizedText) return; // Ignore empty messages
      
      const id = nanoid();
      const payload = {
        type: 'message',
        id,
        room,
        user: { name: user.name, color: user.color },
        ts: Date.now(),
        text: sanitizedText,
        clientId: msg.clientId ? String(msg.clientId).slice(0, 40) : undefined,
        replyTo: msg.replyTo ? sanitizeName(msg.replyTo) : null
      };
      broadcast(room, payload);
      await persistMessage({
        id,
        room,
        user_name: user.name,
        user_color: user.color,
        text: sanitizedText,
        is_trade: false,
        reply_to: payload.replyTo,
        client_id: payload.clientId
      });
      return;
    }

    if (msg.type === 'share') {
      const id = nanoid();
      const payload = {
        type: 'message',
        id,
        room,
        user: { name: user.name, color: user.color },
        ts: Date.now(),
        tradeShare: true,
        share: {
          sym: String(msg.sym || '').toUpperCase().slice(0, 20),
          side: /long/i.test(msg.side) ? 'Long' : 'Short',
          lev: String(msg.lev || '').slice(0, 6),
          entry: String(msg.entry || '').slice(0, 32)
        },
        clientId: msg.clientId ? String(msg.clientId).slice(0, 40) : undefined
      };
      broadcast(room, payload);
      await persistMessage({
        id,
        room,
        user_name: user.name,
        user_color: user.color,
        is_trade: true,
        trade_sym: payload.share.sym,
        trade_side: payload.share.side,
        trade_lev: payload.share.lev,
        trade_entry: payload.share.entry,
        client_id: payload.clientId
      });
      return;
    }
  });

    ws.on('close', () => {
      try { rooms.get(room)?.delete(ws); } catch (_) {}
      try { activeConnections.get(room)?.delete(connectionId); } catch (_) {}
      try { rateLimits.delete(connectionId); } catch (_) {} // Clean up rate limit
      broadcastPresence(room);
    });
  });

  // News WebSocket: push aggregated Phoenix/Tree items
  fastify.get('/ws-news', { websocket: true }, (connection, req) => {
    const ws = connection.socket;
    newsClients.add(ws);
    ws.on('close', () => { try { newsClients.delete(ws); } catch (_) {} });
  });

  // Volatility Alerts WebSocket
  fastify.get('/ws-volatility', { websocket: true }, async (connection, req) => {
    const ws = connection.socket;
    volatilityClients.add(ws);
    
    console.log('[Volatility] Client connected, sending last 10 alerts');
    
    // Send last 10 alerts on connection
    try {
      let alerts = [];
      if (pgClient) {
        const result = await pgClient.query(
          `SELECT id, symbol, exchange, price, change_percent, volume, alert_type,
                  EXTRACT(EPOCH FROM created_at) * 1000 as ts
           FROM volatility_alerts
           ORDER BY created_at DESC
           LIMIT 10`
        );
        alerts = result.rows.reverse().map(row => ({
          id: row.id,
          symbol: row.symbol,
          exchange: row.exchange,
          price: Number(row.price),
          changePercent: Number(row.change_percent),
          volume: Number(row.volume),
          type: row.alert_type,
          timestamp: Number(row.ts)
        }));
      } else {
        alerts = memoryVolatilityAlerts.slice(-10);
      }
      
      // Send history
      ws.send(JSON.stringify({ type: 'history', alerts }));
    } catch (e) {
      fastify.log.error(e, 'Failed to fetch volatility history');
    }
    
    ws.on('close', () => { 
      try { volatilityClients.delete(ws); } catch (_) {} 
      console.log('[Volatility] Client disconnected');
    });
  });
});

// Ingestors for external news sources → store and broadcast
function broadcastNewsItem(item) {
  try {
    const data = JSON.stringify({ item });
    for (const client of newsClients) {
      try { client.send(data); } catch (_) {}
    }
  } catch (_) {}
}

// Broadcast volatility alert to all connected clients
function broadcastVolatilityAlert(alert) {
  try {
    const data = JSON.stringify({ type: 'alert', alert });
    for (const client of volatilityClients) {
      try { client.send(data); } catch (_) {}
    }
    console.log('[Volatility] Broadcasted alert:', alert.symbol, alert.changePercent + '%');
  } catch (e) {
    app.log.error(e, 'Failed to broadcast volatility alert');
  }
}

// Store and broadcast volatility alert
async function pushVolatilityAlert(alert) {
  if (!alert || !alert.symbol) return;
  
  const alertData = {
    id: alert.id || nanoid(),
    symbol: String(alert.symbol).toUpperCase().slice(0, 20),
    exchange: String(alert.exchange || 'UNKNOWN').toUpperCase().slice(0, 20),
    price: Number(alert.price) || 0,
    change_percent: Number(alert.changePercent) || 0,
    volume: Number(alert.volume) || 0,
    alert_type: String(alert.type || 'VOLATILITY').slice(0, 20),
    timestamp: alert.timestamp || Date.now()
  };
  
  // Store in memory
  memoryVolatilityAlerts.push(alertData);
  if (memoryVolatilityAlerts.length > 100) {
    memoryVolatilityAlerts = memoryVolatilityAlerts.slice(-100);
  }
  
  // Store in Postgres
  if (pgClient) {
    try {
      await pgClient.query(
        `INSERT INTO volatility_alerts (id, symbol, exchange, price, change_percent, volume, alert_type, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING`,
        [
          alertData.id,
          alertData.symbol,
          alertData.exchange,
          alertData.price,
          alertData.change_percent,
          alertData.volume,
          alertData.alert_type,
          new Date(alertData.timestamp).toISOString()
        ]
      );
    } catch (e) {
      app.log.error(e, 'Failed to persist volatility alert');
    }
  }
  
  // Broadcast to connected clients
  broadcastVolatilityAlert({
    id: alertData.id,
    symbol: alertData.symbol,
    exchange: alertData.exchange,
    price: alertData.price,
    changePercent: alertData.change_percent,
    volume: alertData.volume,
    type: alertData.alert_type,
    timestamp: alertData.timestamp
  });
}

function normalizePhoenix(msg) {
  try {
    // Helper to pick the first non-empty string among candidates
    const pickFirst = (...vals) => {
      for (const v of vals) {
        if (v === undefined || v === null) continue;
        const s = String(v).trim();
        if (s) return s;
      }
      return '';
    };

    // Accept both Twitter-style and News-style payloads
    const text = pickFirst(msg?.text, msg?.body, msg?.title);

    // Resolve author username/handle from multiple possible locations and formats
    let username = pickFirst(
      msg?.username,
      msg?.screen_name,
      msg?.screenName,
      msg?.handle,
      msg?.user?.username,
      msg?.user?.screen_name,
      msg?.user?.screenName,
      msg?.author?.username,
      msg?.author?.screen_name,
      msg?.author_username,
      msg?.account?.username,
      msg?.source_username,
      msg?.sourceUsername
    );
    if (username && username.startsWith('@')) username = username.slice(1);

    // Resolve display name from various keys (source/name/author)
    const name = pickFirst(
      msg?.name,
      msg?.displayName,
      msg?.user?.name,
      msg?.author?.name,
      msg?.source_name,
      msg?.sourceName,
      msg?.source
    );

    const icon = pickFirst(
      msg?.icon,
      msg?.user?.profile_image_url,
      msg?.user?.profile_image_url_https
    ) || null;

    const url = pickFirst(msg?.url, msg?.tweetUrl, msg?.link) || null;
    const createdAt = msg?.createdAt || msg?.receivedAt || Date.now();

    // Extract coin/symbols (Phoenix may provide either 'coin' or 'symbols')
    const coin = pickFirst(msg?.coin, msg?.symbol, (Array.isArray(msg?.symbols) && msg.symbols[0]));
    const symbols = Array.isArray(msg?.symbols) ? msg.symbols : (coin ? [coin] : []);

    const item = {
      id: msg?._id || msg?.noticeId || nanoid(),
      username,
      name,
      text,
      createdAt,
      receivedAt: msg?.receivedAt || createdAt,
      followers: Number(msg?.followers || 0),
      icon,
      url,
      coin: coin || null,
      symbols,
      images: Array.isArray(msg?.images) ? msg.images : [],
      isRetweet: !!msg?.isRetweet,
      isQuote: !!msg?.isQuote,
      isReply: !!msg?.isReply
    };
    return item;
  } catch (_) { return null; }
}

function pushNews(item) {
  if (!item || !item.text) return;
  // Always keep in memory for quick retrieval
  // Deduplicate by id
  try {
    const idStr = String(item.id);
    const exists = memoryNews.some(m => String(m.id) === idStr);
    if (exists) return;
  } catch (_) {}
  memoryNews.push(item);
  if (memoryNews.length > 1000) memoryNews = memoryNews.slice(-1000);
  saveNews();
  // Persist to Postgres if available
  if (pgClient) {
    try {
      const images = Array.isArray(item.images) ? JSON.stringify(item.images) : JSON.stringify([]);
      const createdAt = item.createdAt ? new Date(item.createdAt) : new Date();
      const receivedAt = item.receivedAt ? new Date(item.receivedAt) : createdAt;
      pgClient.query(
        `INSERT INTO news_items (id, source_name, source_username, text, url, followers, images, coin, symbols, is_retweet, is_quote, is_reply, created_at, received_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT (id) DO NOTHING`,
        [
          String(item.id),
          item.name || null,
          item.username || null,
          item.text || null,
          item.url || null,
          Number(item.followers || 0),
          images,
          item.coin || null,
          JSON.stringify(item.symbols || []),
          !!item.isRetweet,
          !!item.isQuote,
          !!item.isReply,
          createdAt.toISOString(),
          receivedAt.toISOString()
        ]
      ).catch((e)=> app.log.error(e, 'news_items insert error'));
    } catch (e) { app.log.error(e, 'news_items persist error'); }
  }
  broadcastNewsItem(item);
}

// Connect to BWE for volatility alerts
function connectBWE() {
  try {
    const ws = new WebSocket('ws://public.bwe-ws.com:8001/');
    let pingInterval;
    
    ws.on('open', () => {
      app.log.info('[BWE] Connected to volatility alerts');
      console.log('[BWE] Connected successfully');
      
      // Send ping every 8 seconds to keep connection alive
      pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send('ping');
        }
      }, 8000);
    });
    
    ws.on('message', (buf) => {
      try {
        const raw = buf.toString();
        
        // Handle pong responses (keepalive)
        if (raw === 'pong') {
          return;
        }
        
        // Log first real message to understand BWE format
        if (!ws._firstMessageLogged) {
          console.log('[BWE] First alert received:', raw.slice(0, 500));
          ws._firstMessageLogged = true;
        }
        
        // Try to parse as JSON
        let data;
        try {
          data = JSON.parse(raw);
        } catch (parseError) {
          // Log unexpected non-JSON messages
          console.log('[BWE] Non-JSON alert:', raw.slice(0, 200));
          return;
        }
        
        // BWE sends alerts in format: 
        // { title: "Price Monitor: COAIUSDT (COAI) -2.2% in the past 3 seconds", ... }
        
        const alerts = Array.isArray(data) ? data : [data];
        
        for (const item of alerts) {
          if (!item || typeof item !== 'object') continue;
          
          // Extract symbol from title (format: "Price Monitor: BTCUSDT (BTC) +5.2% in the past...")
          let symbol = null;
          let changePercent = 0;
          
          if (item.title) {
            // Match pattern: SYMBOLUSDT (SYMBOL) ±X.X%
            const match = item.title.match(/([A-Z0-9]+USDT)\s*\([A-Z0-9]+\)\s*([-+]?\d+\.?\d*)%/);
            if (match) {
              symbol = match[1]; // e.g., "BTCUSDT"
              changePercent = parseFloat(match[2]); // e.g., -2.2
            }
          }
          
          // Fallback to other fields if available
          if (!symbol) {
            symbol = item.symbol || 
                    item.coin || 
                    (Array.isArray(item.coins_included) && item.coins_included[0]) ||
                    null;
          }
          
          if (!symbol) {
            console.log('[BWE] Could not extract symbol from:', JSON.stringify(item).slice(0, 200));
            continue;
          }
          
          const alert = {
            id: nanoid(),
            symbol: String(symbol).toUpperCase(),
            exchange: item.exchange || 'BWE',
            price: Number(item.price || item.last_price || item.firstPrice?.price || 0),
            changePercent: changePercent || Number(item.changePercent || item.change_percent || item.change || item.percent_change || 0),
            volume: Number(item.volume || item.volume_24h || 0),
            type: item.type || item.alert_type || 'VOLATILITY',
            timestamp: item.time || item.timestamp || Date.now()
          };
          
          console.log('[BWE] New alert:', alert.symbol, (alert.changePercent > 0 ? '+' : '') + alert.changePercent + '%');
          pushVolatilityAlert(alert);
        }
      } catch (e) {
        app.log.error(e, '[BWE] Error processing message');
      }
    });
    
    ws.on('error', (e) => {
      app.log.error(`[BWE] Error: ${e?.message || e}`);
    });
    
    ws.on('close', () => {
      if (pingInterval) clearInterval(pingInterval);
      app.log.warn('[BWE] Connection closed, reconnecting in 5s');
      setTimeout(connectBWE, 5000);
    });
  } catch (e) {
    app.log.error(e, '[BWE] Failed to connect');
    setTimeout(connectBWE, 5000);
  }
}

// External WS connections
function connectExternalSources() {
  const sources = [
    { name: 'TreeOfAlpha', urls: ['wss://news.treeofalpha.com/ws'] },
    { name: 'PhoenixNews', urls: ['wss://wss.phoenixnews.io'] }
  ];
  const wsRefs = new Map();
  const endpointIndex = new Map();

  const connect = (source) => {
    try {
      const urls = source.urls || [];
      const idx = (endpointIndex.get(source.name) || 0) % Math.max(1, urls.length);
      const url = urls[idx];
      const ws = new WebSocket(url);
      wsRefs.set(source.name, ws);

      ws.on('open', () => {
        app.log.info(`${source.name} connected`);
      });
      ws.on('message', (buf) => {
        const dataStr = buf.toString();
        try {
          const data = JSON.parse(dataStr);
          // Accept both formats and normalize
          const candidates = [];
          const primary = normalizePhoenix(data);
          if (primary) candidates.push(primary);
          if (Array.isArray(data?.data)) {
            data.data.forEach((d) => { const m = normalizePhoenix(d); if (m) candidates.push(m); });
          }
          // Push unique items only
          candidates.forEach((n) => pushNews(n));
        } catch (_) {
          // ignore
        }
      });
      ws.on('error', (e) => { app.log.error(`${source.name} error: ${e?.message || e}`); });
      ws.on('close', () => {
        app.log.warn(`${source.name} closed, reconnecting soon`);
        endpointIndex.set(source.name, (idx + 1) % Math.max(1, urls.length));
        setTimeout(() => connect(source), 3000);
      });
    } catch (e) {
      app.log.error(e, `${source.name} connect failed`);
      setTimeout(() => connect(source), 3000);
    }
  };

  sources.forEach(connect);
}

async function start() {
  try {
    // Load messages from file on startup
    loadMessages();
    loadNews();
    
    await initPostgres().catch(() => {});
    await app.listen({ port: Number(PORT), host: '0.0.0.0' });
    console.log(`🚀 Chat server v0.1.1 running on :${PORT}`);
    console.log(`📡 CORS origins: ${JSON.stringify(getAllowedOrigins())}`);
    app.log.info(`Chat server running on :${PORT} with CORS origins: ${JSON.stringify(getAllowedOrigins())}`);
    // Connect external news sources for aggregation
    connectExternalSources();
    // Connect to BWE for volatility alerts
    connectBWE();
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();


