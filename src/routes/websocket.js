// WebSocket routes for chat, news, volatility alerts, and market data hub

const { nanoid } = require('nanoid');
const { sanitizeInput, sanitizeName, checkRateLimit, cleanupRateLimit } = require('../middleware/validation');
const storage = require('../services/storage');
const news = require('../services/news');
const { getHub } = require('../services/hub/PublicDataHub');

// Field length limits (centralized)
const LIMITS = { clientId: 40, symbol: 20, price: 32, leverage: 6, layoutName: 30 };
const clip = (val, limit) => val ? String(val).slice(0, limit) : undefined;

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

// ============= FEED SUBSCRIPTION FACTORY =============
// Handles ws-news and ws-volatility with unified logic

function createFeedHandler(feedName, clientsSet, onSubscribe = null) {
  return async (connection, req) => {
    try {
      const ws = connection.socket;
      let subscribed = false;
      const connectionId = Math.random().toString(36).slice(2);
      console.log(`📰 [${feedName} WS ${connectionId}] Connection opened`);

      const timeout = setTimeout(() => {
        if (!subscribed) {
          console.warn(`⏱️  [${feedName} WS ${connectionId}] Subscription timeout, closing`);
          try { ws.close(4400, 'subscribe required'); } catch (_) {}
        }
      }, 5000);

      ws.on('message', async (raw) => {
        try {
          if (subscribed) return;
          const data = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
          if (data?.type === 'subscribe' && data?.feed === feedName.toLowerCase()) {
            subscribed = true;
            clearTimeout(timeout);
            clientsSet.add(ws);
            console.log(`✅ [${feedName} WS ${connectionId}] Subscribed`);
            if (onSubscribe) await onSubscribe(ws, connectionId);
            return;
          }
          console.warn(`[${feedName} WS ${connectionId}] Invalid subscribe message:`, data);
          try { ws.close(4401, 'invalid subscribe'); } catch (_) {}
        } catch (e) {
          console.error(`[${feedName} WS ${connectionId}] Message error:`, e.message);
          try { ws.close(1011, 'Server error'); } catch (_) {}
        }
      });

      ws.on('error', (error) => {
        console.error(`❌ [${feedName} WS ${connectionId}] Error:`, error.message);
      });

      ws.on('close', () => {
        clearTimeout(timeout);
        if (subscribed) {
          try { clientsSet.delete(ws); } catch (_) {}
        }
        console.log(`👋 [${feedName} WS ${connectionId}] Connection closed`);
      });
    } catch (error) {
      console.error(`❌ [${feedName} WS] Failed to establish connection:`, error.message);
      try { connection.socket.close(1011, 'Server error'); } catch (_) {}
    }
  };
}

// Volatility history sender
async function sendVolatilityHistory(ws, connectionId) {
  try {
    let alerts = [];
    if (storage.pgClient) {
      const columnCheck = await storage.pgClient.query(`
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'volatility_alerts' AND column_name = 'time_period'
      `);
      const hasTimePeriod = columnCheck.rows.length > 0;
      const query = hasTimePeriod
        ? `SELECT id, symbol, exchange, price, change_percent, volume, alert_type, COALESCE(time_period, 30) as time_period, EXTRACT(EPOCH FROM created_at) * 1000 as ts FROM volatility_alerts ORDER BY created_at DESC LIMIT 30`
        : `SELECT id, symbol, exchange, price, change_percent, volume, alert_type, 30 as time_period, EXTRACT(EPOCH FROM created_at) * 1000 as ts FROM volatility_alerts ORDER BY created_at DESC LIMIT 30`;
      const result = await storage.pgClient.query(query);
      alerts = result.rows.reverse().map(row => ({
        id: row.id, symbol: row.symbol, exchange: row.exchange,
        price: Number(row.price), changePercent: Number(row.change_percent),
        volume: Number(row.volume), type: row.alert_type,
        timePeriod: Number(row.time_period) || 30, timestamp: Number(row.ts)
      }));
    } else {
      alerts = storage.memoryVolatilityAlerts.slice(-30).map(a => ({
        ...a, timePeriod: a.timePeriod || a.time_period || 30
      }));
    }
    ws.send(JSON.stringify({ type: 'history', alerts }));
  } catch (e) {
    console.error(`[Volatility WS ${connectionId}] Failed to fetch history:`, e.message);
    ws.send(JSON.stringify({ type: 'error', message: 'Failed to fetch history' }));
  }
}

// ============= CHAT MESSAGE HANDLERS =============

function buildBasePayload(id, room, user, clientIdRaw) {
  return {
    type: 'message',
    id,
    room,
    user: { name: user.name, color: user.color },
    ts: Date.now(),
    clientId: clip(clientIdRaw, LIMITS.clientId)
  };
}

async function handleChatMessage(ws, msg, user, room, connectionId, clientIp) {
  if (!checkRateLimit(connectionId)) {
    console.warn(`⏱️  [WS ${connectionId}] Rate limit exceeded - user: ${user.name}`);
    ws.send(JSON.stringify({ type: 'error', message: 'Rate limit exceeded' }));
    return;
  }
  
  const text = sanitizeInput(msg.text);
  if (!text) return;
  
  const id = nanoid();
  const payload = {
    ...buildBasePayload(id, room, user, msg.clientId),
    text,
    replyTo: msg.replyTo ? sanitizeName(msg.replyTo) : null
  };
  
  console.log(`💬 [WS ${connectionId}] Chat - user: ${user.name}, len: ${text.length}`);
  broadcast(room, payload);
  
  await storage.persistMessage({
    id, room, user_name: user.name, user_color: user.color,
    text, is_trade: false, reply_to: payload.replyTo, client_id: payload.clientId
  }).catch(e => console.error(`❌ [WS ${connectionId}] Persist failed:`, e.message));
}

async function handleTradeShare(ws, msg, user, room, connectionId) {
  const id = nanoid();
  const sym = clip(msg.sym, LIMITS.symbol)?.toUpperCase() || '';
  const side = /long/i.test(msg.side) ? 'Long' : 'Short';
  const lev = clip(msg.lev, LIMITS.leverage);
  const entry = clip(msg.entry, LIMITS.price);
  const takeProfit = clip(msg.takeProfit, LIMITS.price);
  const stopLoss = clip(msg.stopLoss, LIMITS.price);
  
  const payload = {
    ...buildBasePayload(id, room, user, msg.clientId),
    tradeShare: true,
    share: { sym, side, lev, entry, takeProfit, stopLoss }
  };
  
  console.log(`📈 [WS ${connectionId}] Trade share - ${sym} ${side}`);
  broadcast(room, payload);
  
  await storage.persistMessage({
    id, room, user_name: user.name, user_color: user.color, is_trade: true,
    trade_sym: sym, trade_side: side, trade_lev: lev, trade_entry: entry,
    trade_take_profit: takeProfit || null, trade_stop_loss: stopLoss || null,
    client_id: payload.clientId
  }).catch(e => console.error(`❌ [WS ${connectionId}] Trade persist failed:`, e.message));
}

async function handleOrderShare(ws, msg, user, room, connectionId) {
  const id = nanoid();
  const sym = clip(msg.sym, LIMITS.symbol)?.toUpperCase() || '';
  const side = /long/i.test(msg.side) ? 'Long' : 'Short';
  const lev = clip(msg.lev, LIMITS.leverage);
  const price = clip(msg.price, LIMITS.price);
  const qty = clip(msg.qty, LIMITS.price);
  const orderType = clip(msg.orderType || 'Limit', LIMITS.symbol);
  const takeProfit = clip(msg.takeProfit, LIMITS.price);
  const stopLoss = clip(msg.stopLoss, LIMITS.price);
  
  const payload = {
    ...buildBasePayload(id, room, user, msg.clientId),
    orderShare: true,
    order: { sym, side, lev, price, qty, orderType, takeProfit, stopLoss }
  };
  
  console.log(`📋 [WS ${connectionId}] Order share - ${sym} ${side} @ ${price}`);
  broadcast(room, payload);
  
  await storage.persistMessage({
    id, room, user_name: user.name, user_color: user.color, is_order: true,
    order_sym: sym, order_side: side, order_lev: lev, order_price: price,
    order_qty: qty, order_type: orderType, order_take_profit: takeProfit || null,
    order_stop_loss: stopLoss || null, client_id: payload.clientId
  }).catch(e => console.error(`❌ [WS ${connectionId}] Order persist failed:`, e.message));
}

async function handleLayoutShare(ws, msg, user, room, connectionId) {
  const id = nanoid();
  const layoutName = clip(msg.layoutName || 'Layout', LIMITS.layoutName);
  const windowCount = parseInt(msg.windowCount) || 0;
  const windows = Array.isArray(msg.windows) ? msg.windows : [];
  
  const payload = {
    ...buildBasePayload(id, room, user, msg.clientId),
    layoutShare: true,
    layout: { layoutName, windowCount, windows }
  };
  
  console.log(`📐 [WS ${connectionId}] Layout share - ${layoutName} (${windowCount} windows)`);
  broadcast(room, payload);
  
  await storage.persistMessage({
    id, room, user_name: user.name, user_color: user.color, is_layout: true,
    layout_name: layoutName, layout_window_count: windowCount,
    layout_windows: JSON.stringify(windows), client_id: payload.clientId
  }).catch(e => console.error(`❌ [WS ${connectionId}] Layout persist failed:`, e.message));
}

// Message type dispatcher
const messageHandlers = {
  chat: handleChatMessage,
  share: handleTradeShare,
  orderShare: handleOrderShare,
  layoutShare: handleLayoutShare
};

// ============= MAIN EXPORTS =============

module.exports = function(app) {
  app.register(async function (fastify) {
    
    // Main chat WebSocket
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
        const room = 'global';

        console.log(`✅ [WS ${connectionId}] Connection - IP: ${clientIp}`);

        if (!rooms.has(room)) rooms.set(room, new Set());
        rooms.get(room).add(ws);
        
        if (!activeConnections.has(room)) activeConnections.set(room, new Set());
        activeConnections.get(room).add(connectionId);
        broadcastPresence(room);

        ws.on('message', async (raw) => {
          try {
            let msg;
            try { msg = JSON.parse(String(raw)); } catch (e) { return; }
            if (!msg || typeof msg !== 'object') return;

            // Handle hello
            if (msg.type === 'hello') {
              user = {
                name: sanitizeName(msg?.user?.name),
                color: String(msg?.user?.color || '#aaa').match(/^#[0-9A-Fa-f]{6}$/) ? msg.user.color : '#aaa'
              };
              console.log(`👤 [WS ${connectionId}] Hello: ${user.name}`);
              ws.send(JSON.stringify({ type: 'welcome', room, user }));
              broadcastPresence(room);
              return;
            }

            // Dispatch to handler
            const handler = messageHandlers[msg.type];
            if (handler) {
              try {
                await handler(ws, msg, user, room, connectionId, clientIp);
              } catch (e) {
                console.error(`❌ [WS ${connectionId}] ${msg.type} error:`, e.message);
                ws.send(JSON.stringify({ type: 'error', message: `Failed to process ${msg.type}` }));
              }
            }
          } catch (e) {
            console.error(`[WS ${connectionId}] Unexpected error:`, e.message);
          }
        });

        ws.on('error', (error) => {
          console.error(`❌ [WS ${connectionId}] Error:`, error.message);
        });

        ws.on('close', () => {
          const duration = Date.now() - startTime;
          try { rooms.get(room)?.delete(ws); } catch (_) {}
          try { activeConnections.get(room)?.delete(connectionId); } catch (_) {}
          try { cleanupRateLimit(connectionId); } catch (_) {}
          console.log(`👋 [WS ${connectionId}] Closed - ${user.name}, ${duration}ms`);
          broadcastPresence(room);
        });
      } catch (error) {
        console.error(`❌ [WS-ERROR] ${connectionId}:`, error.message);
        try { connection.socket.close(1011, 'Server error'); } catch (_) {}
      }
    });

    // News WebSocket (using factory)
    fastify.get('/ws-news', { websocket: true }, createFeedHandler('News', newsClients));

    // Volatility WebSocket (using factory with history callback)
    fastify.get('/ws-volatility', { websocket: true }, createFeedHandler('Volatility', volatilityClients, sendVolatilityHistory));

    // Setup news clients reference
    news.setClients(newsClients, volatilityClients);

    // Market Data Hub WebSocket
    fastify.get('/ws-market-data', { websocket: true }, (connection, req) => {
      const ws = connection.socket;
      const connectionId = Math.random().toString(36).slice(2);
      const hub = getHub();
      
      console.log(`📊 [MarketData WS ${connectionId}] Connection opened`);

      if (!hub.ready) {
        console.warn(`⚠️ [MarketData WS ${connectionId}] Hub not ready`);
      }

      hub.addClient(ws);

      ws.send(JSON.stringify({
        type: 'connected',
        hubReady: hub.ready,
        exchanges: Object.entries(hub.adapters).map(([name, adapter]) => ({
          name, connected: adapter.isConnected(), symbols: adapter.getSymbolCount()
        })),
        ts: Date.now()
      }));

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          hub.handleClientMessage(ws, msg);
        } catch (e) {
          console.error(`[MarketData WS ${connectionId}] Parse error:`, e.message);
        }
      });

      ws.on('error', (error) => {
        console.error(`❌ [MarketData WS ${connectionId}] Error:`, error.message);
      });

      ws.on('close', () => {
        hub.cleanupClient(ws);
        console.log(`👋 [MarketData WS ${connectionId}] Closed`);
      });
    });
  });
};
