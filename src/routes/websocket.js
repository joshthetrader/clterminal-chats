// WebSocket routes for chat, news, and volatility alerts

const WebSocket = require('ws');
const { nanoid } = require('nanoid');
const { sanitizeInput, sanitizeName, checkRateLimit, cleanupRateLimit } = require('../middleware/validation');
const storage = require('../services/storage');
const news = require('../services/news');

const rooms = new Map();
const activeConnections = new Map();
let newsClients = new Set();
let volatilityClients = new Set();

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

module.exports = function(app) {
  // Main chat WebSocket
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

      broadcastPresence(room);

      ws.on('error', (err) => {
        console.error('[WS Chat] Connection error:', err.message);
      });

      ws.on('message', async (raw) => {
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
          if (!checkRateLimit(connectionId)) {
            ws.send(JSON.stringify({ type: 'error', message: 'Rate limit exceeded' }));
            return;
          }
          
          const sanitizedText = sanitizeInput(msg.text);
          if (!sanitizedText) return;
          
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
          await storage.persistMessage({
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
          await storage.persistMessage({
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
        try { cleanupRateLimit(connectionId); } catch (_) {}
        broadcastPresence(room);
      });
    });

    // News WebSocket
    fastify.get('/ws-news', { websocket: true }, (connection, req) => {
      const ws = connection.socket;
      let subscribed = false;
      const timeout = setTimeout(() => {
        if (!subscribed) {
          try { ws.close(4400, 'subscribe required'); } catch (_) {}
        }
      }, 5000);

      ws.on('error', (err) => {
        console.error('[WS News] Connection error:', err.message);
      });

      ws.on('message', (raw) => {
        if (subscribed) return;
        try {
          const data = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
          if (data?.type === 'subscribe' && data?.feed === 'news') {
            subscribed = true;
            clearTimeout(timeout);
      newsClients.add(ws);
            return;
          }
        } catch (_) {}
        try { ws.close(4401, 'invalid subscribe'); } catch (_) {}
      });

      ws.on('close', () => {
        clearTimeout(timeout);
        if (subscribed) {
          try { newsClients.delete(ws); } catch (_) {}
        }
      });
    });

    // Volatility Alerts WebSocket
    fastify.get('/ws-volatility', { websocket: true }, async (connection, req) => {
      const ws = connection.socket;
      let subscribed = false;
      const subscribeTimeout = setTimeout(() => {
        if (!subscribed) {
          try { ws.close(4400, 'subscribe required'); } catch (_) {}
        }
      }, 5000);

      const sendHistory = async () => {
      console.log('[Volatility] Client connected, sending last 10 alerts');
      try {
        let alerts = [];
        if (storage.pgClient) {
          const result = await storage.pgClient.query(
            `SELECT id, symbol, exchange, price, change_percent, volume, alert_type, EXTRACT(EPOCH FROM created_at) * 1000 as ts
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
          alerts = storage.memoryVolatilityAlerts.slice(-10);
        }
        
        ws.send(JSON.stringify({ type: 'history', alerts }));
      } catch (e) {
        fastify.log.error(e, 'Failed to fetch volatility history');
      }
      };

      ws.on('error', (err) => {
        console.error('[WS Volatility] Connection error:', err.message);
      });

      ws.on('message', async (raw) => {
        if (subscribed) return;
        try {
          const data = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
          if (data?.type === 'subscribe' && data?.feed === 'volatility') {
            subscribed = true;
            clearTimeout(subscribeTimeout);
            volatilityClients.add(ws);
            await sendHistory();
            return;
          }
        } catch (_) {}
        try { ws.close(4401, 'invalid subscribe'); } catch (_) {}
      });
      
      ws.on('close', () => { 
        clearTimeout(subscribeTimeout);
        if (subscribed) {
        try { volatilityClients.delete(ws); } catch (_) {} 
        }
        console.log('[Volatility] Client disconnected');
      });
    });

    // Setup news clients
    news.setClients(newsClients, volatilityClients);
  });
};

