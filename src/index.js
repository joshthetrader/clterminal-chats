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
    'https://cryptolegendsweb-production.up.railway.app',
    'https://cryptolegendsweb.vercel.app'
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
      is_retweet BOOLEAN DEFAULT FALSE,
      is_quote BOOLEAN DEFAULT FALSE,
      is_reply BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      received_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS news_items_created_at ON news_items(created_at DESC);
  `);

  // Online migration: ensure client_id exists on chat_messages for persistence
  await pgClient.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS client_id TEXT`);
}

const app = Fastify({ logger: true });

app.register(fastifyCors, { origin: getAllowedOrigins(), credentials: true });
app.register(fastifyWebsocket);

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

// News: fetch last N items
app.get('/api/news', async (request, reply) => {
  const limit = Math.min(Number(request.query.limit) || 100, 200);
  try {
    if (pgClient) {
      // Prefer DB results if available
      const result = await pgClient.query(
        `SELECT id, source_name, source_username, text, url, followers, images, is_retweet, is_quote, is_reply,
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

function normalizePhoenix(msg) {
  try {
    // Accept both Twitter-style and News-style payloads
    const text = msg?.text || msg?.body || msg?.title || '';
    // Resolve author fields from multiple possible locations
    const username = (
      msg?.username ||
      msg?.screen_name ||
      msg?.user?.username ||
      msg?.user?.screen_name ||
      msg?.sourceName ||
      ''
    );
    const name = (
      msg?.name ||
      msg?.user?.name ||
      msg?.source ||
      ''
    );
    const icon = (
      msg?.icon ||
      msg?.user?.profile_image_url ||
      msg?.user?.profile_image_url_https ||
      null
    );
    const url = msg?.url || msg?.tweetUrl || msg?.link || null;
    const createdAt = msg?.createdAt || msg?.receivedAt || Date.now();
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
        `INSERT INTO news_items (id, source_name, source_username, text, url, followers, images, is_retweet, is_quote, is_reply, created_at, received_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (id) DO NOTHING`,
        [
          String(item.id),
          item.name || null,
          item.username || null,
          item.text || null,
          item.url || null,
          Number(item.followers || 0),
          images,
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
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();


