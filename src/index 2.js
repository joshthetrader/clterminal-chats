'use strict';

const Fastify = require('fastify');
const fastifyCors = require('@fastify/cors');
const fastifyWebsocket = require('@fastify/websocket');
const { nanoid } = require('nanoid');
const { Client } = require('pg');

const PORT = process.env.PORT || 8080;
const ORIGIN = process.env.CORS_ORIGIN || 'http://127.0.0.1:3000';

// Rate limiting per connection
const rateLimits = new Map(); // connectionId -> { count, resetTime }

// Postgres connection (optional in dev). If not configured, fall back to in-memory.
const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
let pgClient = null;

// In-memory message store for development (when no database)
let memoryMessages = [];

// File-based persistence for development
const fs = require('fs');
const path = require('path');
const MESSAGES_FILE = path.join(__dirname, '..', 'data', 'messages.json');

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
  `);
}

const app = Fastify({ logger: true });

app.register(fastifyCors, { origin: ORIGIN, credentials: true });
app.register(fastifyWebsocket, {
  options: { maxPayload: 1048576 }
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

app.register(async function (fastify) {
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
});

async function start() {
  try {
    // Load messages from file on startup
    loadMessages();
    
    await initPostgres().catch(() => {});
    await app.listen({ port: Number(PORT), host: '0.0.0.0' });
    app.log.info(`Chat server running on :${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();


