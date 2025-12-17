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
      const connectionId = Math.random().toString(36).slice(2);
      const clientIp = req.ip || 'unknown';
      const startTime = Date.now();
      
      try {
        const ws = connection.socket;
        if (!ws) {
          console.error(`❌ [WS ${connectionId}] Invalid socket connection`);
          try { connection.socket?.close(1011, 'Invalid connection'); } catch (_) {}
          return;
        }
        
        let user = { name: 'Anon', color: '#aaa' };
        let clientId = null;
        const room = 'global';

        console.log(`✅ [WS ${connectionId}] Connection established - IP: ${clientIp}, Host: ${req.hostname}, UserAgent: ${req.headers['user-agent']?.substring(0, 60)}`);

        if (!rooms.has(room)) rooms.set(room, new Set());
        rooms.get(room).add(ws);
        
        if (!activeConnections.has(room)) activeConnections.set(room, new Set());
        activeConnections.get(room).add(connectionId);

        broadcastPresence(room);

      ws.on('message', async (raw) => {
        try {
          let msg = null;
          try { msg = JSON.parse(String(raw)); } catch (e) {
            console.warn(`[WS ${connectionId}] Invalid JSON received:`, e.message);
            return;
          }
          if (!msg || typeof msg !== 'object') return;

          if (msg.type === 'hello') {
            try {
              user = {
                name: sanitizeName(msg?.user?.name),
                color: String(msg?.user?.color || '#aaa').match(/^#[0-9A-Fa-f]{6}$/) ? msg.user.color : '#aaa'
              };
              clientId = msg.clientId ? String(msg.clientId).slice(0, 40) : null;
              console.log(`👤 [WS ${connectionId}] User hello: ${user.name} (${user.color}), clientId: ${clientId}`);
              ws.send(JSON.stringify({ type: 'welcome', room, user }));
              broadcastPresence(room);
              return;
            } catch (e) {
              console.error(`[WS ${connectionId}] Error handling hello:`, e.message);
              ws.send(JSON.stringify({ type: 'error', message: 'Failed to process hello message' }));
            }
          }

          if (msg.type === 'chat') {
            try {
              if (!checkRateLimit(connectionId)) {
                console.warn(`⏱️  [WS ${connectionId}] Rate limit exceeded - user: ${user.name}, IP: ${clientIp}`);
                ws.send(JSON.stringify({ type: 'error', message: 'Rate limit exceeded' }));
                return;
              }
              
              const sanitizedText = sanitizeInput(msg.text);
              if (!sanitizedText) {
                console.warn(`[WS ${connectionId}] Empty message from ${user.name}`);
                return;
              }
              
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
              
              const msgDetails = {
                id,
                user: user.name,
                length: sanitizedText.length,
                hasReply: !!payload.replyTo,
                clientId: payload.clientId
              };
              console.log(`💬 [WS ${connectionId}] Chat message - ${JSON.stringify(msgDetails)}`);
              
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
              }).catch(e => {
                const errDetails = { user: user.name, error: e.message, code: e.code };
                console.error(`❌ [WS ${connectionId}] Persist failed - ${JSON.stringify(errDetails)}`);
              });
              return;
            } catch (e) {
              const errDetails = { error: e.message, user: user.name, type: 'chat' };
              console.error(`❌ [WS ${connectionId}] Error - ${JSON.stringify(errDetails)}`);
              ws.send(JSON.stringify({ type: 'error', message: 'Failed to send message' }));
            }
          }

          if (msg.type === 'share') {
            try {
              const id = nanoid();
              const sym = String(msg.sym || '').toUpperCase().slice(0, 20);
              const side = /long/i.test(msg.side) ? 'Long' : 'Short';
              const lev = String(msg.lev || '').slice(0, 6);
              const entry = String(msg.entry || '').slice(0, 32);
              const takeProfit = msg.takeProfit ? String(msg.takeProfit).slice(0, 32) : undefined;
              const stopLoss = msg.stopLoss ? String(msg.stopLoss).slice(0, 32) : undefined;
              
              const payload = {
                type: 'message',
                id,
                room,
                user: { name: user.name, color: user.color },
                ts: Date.now(),
                tradeShare: true,
                share: {
                  sym,
                  side,
                  lev,
                  entry,
                  takeProfit,
                  stopLoss
                },
                clientId: msg.clientId ? String(msg.clientId).slice(0, 40) : undefined
              };
              
              const tradeDetails = {
                symbol: sym,
                side,
                leverage: lev,
                entry,
                takeProfit,
                stopLoss,
                user: user.name,
                clientId: payload.clientId
              };
              console.log(`📈 [WS ${connectionId}] Trade share - ${JSON.stringify(tradeDetails)}`);
              
              broadcast(room, payload);
              
              await storage.persistMessage({
                id,
                room,
                user_name: user.name,
                user_color: user.color,
                is_trade: true,
                trade_sym: sym,
                trade_side: side,
                trade_lev: lev,
                trade_entry: entry,
                trade_take_profit: takeProfit || null,
                trade_stop_loss: stopLoss || null,
                client_id: payload.clientId
              }).catch(e => {
                const errDetails = { symbol: sym, side, error: e.message };
                console.error(`❌ [WS ${connectionId}] Trade persist failed - ${JSON.stringify(errDetails)}`);
              });
              return;
            } catch (e) {
              const errDetails = { error: e.message, type: 'share', user: user.name };
              console.error(`❌ [WS ${connectionId}] Error - ${JSON.stringify(errDetails)}`);
              ws.send(JSON.stringify({ type: 'error', message: 'Failed to share trade' }));
            }
          }

          if (msg.type === 'layoutShare') {
            try {
              const id = nanoid();
              const layoutName = String(msg.layoutName || 'Layout').slice(0, 30);
              const windowCount = parseInt(msg.windowCount) || 0;
              const windows = Array.isArray(msg.windows) ? msg.windows : [];
              
              const payload = {
                type: 'message',
                id,
                room,
                user: { name: user.name, color: user.color },
                ts: Date.now(),
                layoutShare: true,
                layout: {
                  layoutName,
                  windowCount,
                  windows
                },
                clientId: msg.clientId ? String(msg.clientId).slice(0, 40) : undefined
              };
              
              const layoutDetails = {
                name: layoutName,
                windowCount,
                user: user.name,
                clientId: payload.clientId
              };
              console.log(`📐 [WS ${connectionId}] Layout share - ${JSON.stringify(layoutDetails)}`);
              
              broadcast(room, payload);
              
              await storage.persistMessage({
                id,
                room,
                user_name: user.name,
                user_color: user.color,
                is_layout: true,
                layout_name: layoutName,
                layout_window_count: windowCount,
                layout_windows: JSON.stringify(windows),
                client_id: payload.clientId
              }).catch(e => {
                const errDetails = { layoutName, error: e.message };
                console.error(`❌ [WS ${connectionId}] Layout persist failed - ${JSON.stringify(errDetails)}`);
              });
              return;
            } catch (e) {
              const errDetails = { error: e.message, type: 'layoutShare', user: user.name };
              console.error(`❌ [WS ${connectionId}] Error - ${JSON.stringify(errDetails)}`);
              ws.send(JSON.stringify({ type: 'error', message: 'Failed to share layout' }));
            }
          }
        } catch (e) {
          console.error(`[WS ${connectionId}] Unexpected error in message handler:`, e.message);
        }
      });

      ws.on('error', (error) => {
        console.error(`❌ [WS ${connectionId}] Error event:`, error.message);
      });

      ws.on('close', () => {
        const duration = Date.now() - startTime;
        try { rooms.get(room)?.delete(ws); } catch (_) {}
        try { activeConnections.get(room)?.delete(connectionId); } catch (_) {}
        try { cleanupRateLimit(connectionId); } catch (_) {}
        console.log(`👋 [WS ${connectionId}] Connection closed - user: ${user.name}, duration: ${duration}ms`);
        broadcastPresence(room);
      });
      } catch (error) {
        const details = {
          timestamp: new Date().toISOString(),
          path: '/ws',
          method: 'GET',
          ip: clientIp,
          error: error.message,
          stack: error.stack?.split('\n')[0]
        };
        console.error(`❌ [WS-ERROR] ${JSON.stringify(details)}`);
        try { connection.socket.close(1011, 'Server error'); } catch (_) {}
      }
    });

    // News WebSocket
    fastify.get('/ws-news', { websocket: true }, (connection, req) => {
      try {
        const ws = connection.socket;
        let subscribed = false;
        const connectionId = Math.random().toString(36).slice(2);
        console.log(`📰 [News WS ${connectionId}] Connection opened`);
        
        const timeout = setTimeout(() => {
          if (!subscribed) {
            console.warn(`⏱️  [News WS ${connectionId}] Subscription timeout, closing`);
            try { ws.close(4400, 'subscribe required'); } catch (_) {}
          }
        }, 5000);

        ws.on('message', (raw) => {
          try {
            if (subscribed) return;
            const data = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
            if (data?.type === 'subscribe' && data?.feed === 'news') {
              subscribed = true;
              clearTimeout(timeout);
              newsClients.add(ws);
              console.log(`✅ [News WS ${connectionId}] Subscribed`);
              return;
            }
            console.warn(`[News WS ${connectionId}] Invalid subscribe message:`, data);
            try { ws.close(4401, 'invalid subscribe'); } catch (_) {}
          } catch (e) {
            console.error(`[News WS ${connectionId}] Message error:`, e.message);
            try { ws.close(1011, 'Server error'); } catch (_) {}
          }
        });

        ws.on('error', (error) => {
          console.error(`❌ [News WS ${connectionId}] Error:`, error.message);
        });

        ws.on('close', () => {
          clearTimeout(timeout);
          if (subscribed) {
            try { newsClients.delete(ws); } catch (_) {}
          }
          console.log(`👋 [News WS ${connectionId}] Connection closed`);
        });
      } catch (error) {
        console.error('❌ [News WS] Failed to establish connection:', error.message);
        try { connection.socket.close(1011, 'Server error'); } catch (_) {}
      }
    });

    // Volatility Alerts WebSocket
    fastify.get('/ws-volatility', { websocket: true }, async (connection, req) => {
      try {
        const ws = connection.socket;
        let subscribed = false;
        const connectionId = Math.random().toString(36).slice(2);
        console.log(`📊 [Volatility WS ${connectionId}] Connection opened`);
        
        const subscribeTimeout = setTimeout(() => {
          if (!subscribed) {
            console.warn(`⏱️  [Volatility WS ${connectionId}] Subscription timeout, closing`);
            try { ws.close(4400, 'subscribe required'); } catch (_) {}
          }
        }, 5000);

        const sendHistory = async () => {
          try {
            console.log(`[Volatility WS ${connectionId}] Sending last 10 alerts`);
            let alerts = [];
            if (storage.pgClient) {
              // Check if time_period column exists, then query accordingly
              const columnCheck = await storage.pgClient.query(`
                SELECT column_name 
                FROM information_schema.columns 
                WHERE table_name = 'volatility_alerts' AND column_name = 'time_period'
              `);
              const hasTimePeriod = columnCheck.rows.length > 0;
              
              const query = hasTimePeriod
                ? `SELECT id, symbol, exchange, price, change_percent, volume, alert_type, COALESCE(time_period, 30) as time_period, EXTRACT(EPOCH FROM created_at) * 1000 as ts
                   FROM volatility_alerts
                   ORDER BY created_at DESC
                   LIMIT 10`
                : `SELECT id, symbol, exchange, price, change_percent, volume, alert_type, 30 as time_period, EXTRACT(EPOCH FROM created_at) * 1000 as ts
                   FROM volatility_alerts
                   ORDER BY created_at DESC
                   LIMIT 10`;
              
              const result = await storage.pgClient.query(query);
              alerts = result.rows.reverse().map(row => ({
                id: row.id,
                symbol: row.symbol,
                exchange: row.exchange,
                price: Number(row.price),
                changePercent: Number(row.change_percent),
                volume: Number(row.volume),
                type: row.alert_type,
                timePeriod: Number(row.time_period) || 30,
                timestamp: Number(row.ts)
              }));
            } else {
              alerts = storage.memoryVolatilityAlerts.slice(-10).map(alert => ({
                ...alert,
                timePeriod: alert.timePeriod || alert.time_period || 30
              }));
            }
            
            ws.send(JSON.stringify({ type: 'history', alerts }));
          } catch (e) {
            console.error(`[Volatility WS ${connectionId}] Failed to fetch history:`, e.message);
            ws.send(JSON.stringify({ type: 'error', message: 'Failed to fetch history' }));
          }
        };

        ws.on('message', async (raw) => {
          try {
            if (subscribed) return;
            const data = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
            if (data?.type === 'subscribe' && data?.feed === 'volatility') {
              subscribed = true;
              clearTimeout(subscribeTimeout);
              volatilityClients.add(ws);
              console.log(`✅ [Volatility WS ${connectionId}] Subscribed`);
              await sendHistory();
              return;
            }
            console.warn(`[Volatility WS ${connectionId}] Invalid subscribe message:`, data);
            try { ws.close(4401, 'invalid subscribe'); } catch (_) {}
          } catch (e) {
            console.error(`[Volatility WS ${connectionId}] Message error:`, e.message);
            try { ws.close(1011, 'Server error'); } catch (_) {}
          }
        });

        ws.on('error', (error) => {
          console.error(`❌ [Volatility WS ${connectionId}] Error:`, error.message);
        });
        
        ws.on('close', () => { 
          clearTimeout(subscribeTimeout);
          if (subscribed) {
            try { volatilityClients.delete(ws); } catch (_) {} 
          }
          console.log(`👋 [Volatility WS ${connectionId}] Connection closed`);
        });
      } catch (error) {
        console.error('❌ [Volatility WS] Failed to establish connection:', error.message);
        try { connection.socket.close(1011, 'Server error'); } catch (_) {}
      }
    });

    // Setup news clients
    news.setClients(newsClients, volatilityClients);
  });
};

