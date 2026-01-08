// REST API endpoints

const { nanoid } = require('nanoid');
const { ADMIN_TOKEN, ENABLE_TRADE_EVENTS_READ } = require('../config/constants');
const storage = require('../services/storage');
const { getHub } = require('../services/hub/PublicDataHub');

// Helper to transform message row to API response format
function mapMessageRow(row, room) {
  const parseWindows = (w) => {
    if (!w) return [];
    return typeof w === 'string' ? JSON.parse(w) : w;
  };
  
  return {
    type: 'message',
    id: row.id,
    room: room || row.room,
    user: { name: row.user_name, color: row.user_color },
    ts: Number(row.ts) || row.ts,
    text: row.text,
    tradeShare: !!row.is_trade,
    share: row.is_trade ? {
      sym: row.trade_sym,
      side: row.trade_side,
      lev: row.trade_lev,
      entry: row.trade_entry,
      takeProfit: row.trade_take_profit || undefined,
      stopLoss: row.trade_stop_loss || undefined
    } : undefined,
    orderShare: !!row.is_order,
    order: row.is_order ? {
      sym: row.order_sym,
      side: row.order_side,
      lev: row.order_lev,
      price: row.order_price,
      qty: row.order_qty,
      orderType: row.order_type,
      takeProfit: row.order_take_profit || undefined,
      stopLoss: row.order_stop_loss || undefined
    } : undefined,
    layoutShare: !!row.is_layout,
    layout: row.is_layout ? {
      layoutName: row.layout_name,
      windowCount: row.layout_window_count,
      windows: parseWindows(row.layout_windows)
    } : undefined,
    replyTo: row.reply_to,
    clientId: row.client_id
  };
}

// News cache to prevent repeated DB queries
const NEWS_CACHE_TTL = 30000; // 30 seconds
let newsCache = { data: null, ts: 0 };

// Rate limiting per IP for /api/news (protects against buggy cached clients)
const NEWS_RATE_LIMIT_MS = 5000; // Max 1 request per 5 seconds per IP
const newsRateLimitMap = new Map(); // IP -> last request timestamp

// Cleanup old rate limit entries every 60 seconds
setInterval(() => {
  const now = Date.now();
  for (const [ip, ts] of newsRateLimitMap.entries()) {
    if (now - ts > 60000) newsRateLimitMap.delete(ip);
  }
}, 60000);

module.exports = function(app) {
  // Clear messages
  app.delete('/api/messages/clear', async (request, reply) => {
    try {
      if (storage.pgClient) {
        await storage.pgClient.query('DELETE FROM chat_messages');
        console.log('[Postgres] Cleared all messages');
      } else {
        storage.memoryMessages = [];
        storage.saveMessages();
        console.log('[Memory] Cleared all messages');
      }
      return { ok: true, message: 'All messages cleared' };
    } catch (error) {
      console.error('[Clear] Error:', error);
      return reply.code(500).send({ error: 'Failed to clear messages' });
    }
  });

  // Get recent news (with caching + rate limiting)
  app.get('/api/news', async (request, reply) => {
    // Get client IP (Railway uses x-forwarded-for)
    const clientIp = request.headers['x-forwarded-for']?.split(',')[0]?.trim() 
                  || request.headers['x-real-ip'] 
                  || request.ip 
                  || 'unknown';
    const now = Date.now();
    
    // Rate limit check - 1 request per 5 seconds per IP
    const lastRequest = newsRateLimitMap.get(clientIp) || 0;
    if (now - lastRequest < NEWS_RATE_LIMIT_MS) {
      const retryAfter = Math.ceil((NEWS_RATE_LIMIT_MS - (now - lastRequest)) / 1000);
      console.warn(`⚠️ [Rate Limit] /api/news blocked for IP ${clientIp} - retry in ${retryAfter}s`);
      reply.code(429);
      reply.header('Retry-After', retryAfter);
      reply.header('X-RateLimit-Reset', new Date(lastRequest + NEWS_RATE_LIMIT_MS).toISOString());
      return { error: 'Too many requests', retryAfter };
    }
    newsRateLimitMap.set(clientIp, now);
    
    const limit = Math.min(Number(request.query.limit) || 100, 200);
    
    // Check cache first
    if (newsCache.data && (now - newsCache.ts) < NEWS_CACHE_TTL) {
      const cachedItems = newsCache.data.slice(0, limit);
      reply.header('X-News-Cache', 'HIT');
      return { items: cachedItems };
    }
    
    try {
      if (storage.pgClient) {
        const result = await storage.pgClient.query(
          `SELECT id, source_name, source_username, text, url, followers, coin, symbols, is_retweet, is_quote, is_reply,
                  EXTRACT(EPOCH FROM created_at) * 1000 as created_ms,
                  EXTRACT(EPOCH FROM COALESCE(received_at, created_at)) * 1000 as received_ms
           FROM news_items
           ORDER BY created_at DESC
           LIMIT 200`,
          []
        );
        const items = (result.rows || []).map(r => ({
          id: r.id,
          name: r.source_name,
          username: r.source_username,
          text: r.text,
          url: r.url,
          followers: Number(r.followers || 0),
          coin: r.coin || null,
          symbols: Array.isArray(r.symbols) ? r.symbols : (typeof r.symbols === 'string' ? JSON.parse(r.symbols) : []),
          isRetweet: !!r.is_retweet,
          isQuote: !!r.is_quote,
          isReply: !!r.is_reply,
          createdAt: Number(r.created_ms) || Date.now(),
          receivedAt: Number(r.received_ms) || Number(r.created_ms) || Date.now()
        })).reverse();
        
        // Update cache
        newsCache = { data: items, ts: now };
        
        reply.header('X-News-Cache', 'MISS');
        return { items: items.slice(0, limit) };
      }
      const items = storage.memoryNews.slice(-limit).reverse();
      return { items };
    } catch (e) {
      app.log.error(e, 'Failed to fetch news');
      return { items: [] };
    }
  });

  // Get recent chat messages
  app.get('/api/messages/:room', async (request, reply) => {
    const room = String(request.params.room || 'global');
    const limit = Math.min(Number(request.query.limit) || 50, 100);
    const before = request.query.before ? Number(request.query.before) : null;
    
    try {
      if (storage.pgClient) {
        let query = `
          SELECT id, user_name, user_color, text, is_trade, trade_sym, trade_side, trade_lev, trade_entry, trade_take_profit, trade_stop_loss,
                 is_order, order_sym, order_side, order_lev, order_price, order_qty, order_type, order_take_profit, order_stop_loss,
                 is_layout, layout_name, layout_window_count, layout_windows, reply_to, client_id,
                 EXTRACT(EPOCH FROM created_at) * 1000 as ts
          FROM chat_messages 
          WHERE room = $1
        `;
        const params = [room, limit];
        
        if (before) {
          query += ` AND created_at < TO_TIMESTAMP($3/1000.0)`;
          params.push(before);
        }
        
        query += ` ORDER BY created_at DESC LIMIT $2`;
        
        const result = await storage.pgClient.query(query, params);
        const messages = result.rows.reverse().map(row => mapMessageRow(row, room));
        return { messages };
      } else {
        let messages = storage.memoryMessages.filter(m => m.room === room);
        
        if (before) {
          messages = messages.filter(m => m.ts < before);
        }
        
        const slicedMessages = messages
          .slice(-limit)
          .map(m => mapMessageRow(m, room));
          
        return { messages: slicedMessages };
      }
    } catch (e) {
      app.log.error(e, 'Failed to fetch messages');
      return { messages: [] };
    }
  });

  // Trade events endpoint
  app.post('/api/trade-events', async (request, reply) => {
    try {
      const body = request.body || {};
      const type = String(body.type || '').toUpperCase();
      const exchange = String(body.exchange || '').toLowerCase();
      const clientId = body.clientId ? String(body.clientId).slice(0, 64) : null;
      if (!type || !exchange) return reply.code(400).send({ error: 'type and exchange required' });

      if (type === 'ORDER_NEW' && body.order) {
        const o = body.order;
        const orderId = String(o.id || o.orderId || '').slice(0, 100);
        if (!orderId) return reply.code(400).send({ error: 'order.id required' });
        if (storage.pgClient) {
          await storage.pgClient.query(
            `INSERT INTO orders (id, client_order_id, exchange, symbol, side, type, price, qty, status, client_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, updated_at = NOW()`,
            [orderId, o.clientOrderId || null, exchange, (o.symbol || o.instId || '').toUpperCase(), o.side || null, o.type || null, o.price != null ? Number(o.price) : null, o.qty != null ? Number(o.qty) : null, o.status || null, clientId]
          );
        }
        return { ok: true };
      }

      if (type === 'FILL' && body.fill) {
        const f = body.fill;
        const fillId = String(f.id || f.tradeId || '').slice(0, 120);
        const orderId = String(f.orderId || '').slice(0, 100);
        if (!fillId || !orderId) return reply.code(400).send({ error: 'fill.id and fill.orderId required' });
        if (storage.pgClient) {
          await storage.pgClient.query(
            `INSERT INTO fills (id, order_id, exchange, symbol, price, qty, fee, liquidity, ts)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TO_TIMESTAMP($9/1000.0))
             ON CONFLICT (id) DO NOTHING`,
            [fillId, orderId, exchange, (f.symbol || '').toUpperCase(), Number(f.price), Number(f.qty), f.fee != null ? Number(f.fee) : null, f.liquidity || null, Number(f.ts || Date.now())]
          );
        }
        return { ok: true };
      }

      const eventId = String(body.id || nanoid()).slice(0, 120);
      const orderId = body.orderId ? String(body.orderId).slice(0, 100) : null;
      if (storage.pgClient) {
        await storage.pgClient.query(
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

  // Get trade events (protected)
  app.get('/api/trade-events', async (request, reply) => {
    if (!ENABLE_TRADE_EVENTS_READ) {
      return reply.code(404).send({ error: 'not_found' });
    }
    const hdr = request.headers || {};
    const bearer = typeof hdr['authorization'] === 'string' ? hdr['authorization'].replace(/^Bearer\s+/i, '') : '';
    const token = hdr['x-admin-token'] || hdr['x-adminkey'] || bearer || '';
    if (!ADMIN_TOKEN || String(token) !== String(ADMIN_TOKEN)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }

    const limit = Math.min(Number(request.query.limit) || 100, 500);
    const exchange = request.query.exchange ? String(request.query.exchange).toLowerCase() : null;
    
    if (!storage.pgClient) {
      return { orders: [], fills: [], events: [] };
    }
    
    try {
      let ordersQuery = `SELECT id, client_order_id, exchange, symbol, side, type, price, qty, status, EXTRACT(EPOCH FROM created_at) * 1000 as ts FROM orders`;
      const ordersParams = [];
      if (exchange) {
        ordersQuery += ` WHERE exchange = $1`;
        ordersParams.push(exchange);
      }
      ordersQuery += ` ORDER BY created_at DESC LIMIT $${ordersParams.length + 1}`;
      ordersParams.push(limit);
      
      const ordersResult = await storage.pgClient.query(ordersQuery, ordersParams);
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
      
      return { orders, fills: [], events: [] };
    } catch (e) {
      app.log.error(e, 'Failed to fetch trade events');
      return { orders: [], fills: [], events: [] };
    }
  });

  // ============= PUBLIC DATA HUB ENDPOINTS =============

  // Hub health check (detailed)
  app.get('/hub/health', async (request, reply) => {
    try {
      const hub = getHub();
      return hub.getHealth();
    } catch (e) {
      app.log.error(e, 'Hub health check failed');
      return reply.code(500).send({
        status: 'error',
        error: e.message,
        timestamp: Date.now()
      });
    }
  });

  // Get all tickers for an exchange
  app.get('/hub/tickers/:exchange', async (request, reply) => {
    try {
      const hub = getHub();
      const exchange = String(request.params.exchange).toLowerCase();
      const tickers = await hub.getTickers(exchange);
      return { exchange, count: tickers.length, tickers };
    } catch (e) {
      app.log.error(e, 'Failed to fetch tickers');
      return reply.code(500).send({ error: e.message });
    }
  });

  // Get specific ticker
  app.get('/hub/ticker/:exchange/:symbol', async (request, reply) => {
    try {
      const hub = getHub();
      const exchange = String(request.params.exchange).toLowerCase();
      const symbol = String(request.params.symbol).toUpperCase();
      const ticker = hub.getTicker(exchange, symbol);
      if (!ticker) {
        return reply.code(404).send({ error: 'Ticker not found' });
      }
      return ticker;
    } catch (e) {
      app.log.error(e, 'Failed to fetch ticker');
      return reply.code(500).send({ error: e.message });
    }
  });

  // Get orderbook
  app.get('/hub/orderbook/:exchange/:symbol', async (request, reply) => {
    try {
      const hub = getHub();
      const exchange = String(request.params.exchange).toLowerCase();
      const symbol = String(request.params.symbol).toUpperCase();
      const orderbook = hub.getOrderbook(exchange, symbol);
      if (!orderbook) {
        return reply.code(404).send({ error: 'Orderbook not found' });
      }
      return orderbook;
    } catch (e) {
      app.log.error(e, 'Failed to fetch orderbook');
      return reply.code(500).send({ error: e.message });
    }
  });

  // Get recent trades
  app.get('/hub/trades/:exchange/:symbol', async (request, reply) => {
    try {
      const hub = getHub();
      const exchange = String(request.params.exchange).toLowerCase();
      const symbol = String(request.params.symbol).toUpperCase();
      const limit = Math.min(Number(request.query.limit) || 50, 100);
      const trades = hub.getTrades(exchange, symbol, limit);
      return { exchange, symbol, count: trades.length, trades };
    } catch (e) {
      app.log.error(e, 'Failed to fetch trades');
      return reply.code(500).send({ error: e.message });
    }
  });

  // Get instruments
  app.get('/hub/instruments/:exchange', async (request, reply) => {
    try {
      const hub = getHub();
      const exchange = String(request.params.exchange).toLowerCase();
      const instruments = hub.getInstruments(exchange);
      return { exchange, count: instruments.length, instruments };
    } catch (e) {
      app.log.error(e, 'Failed to fetch instruments');
      return reply.code(500).send({ error: e.message });
    }
  });

  // Get funding rates
  app.get('/hub/funding/:exchange', async (request, reply) => {
    try {
      const hub = getHub();
      const exchange = String(request.params.exchange).toLowerCase();
      const funding = hub.getFunding(exchange);
      return { exchange, count: funding.length, funding };
    } catch (e) {
      app.log.error(e, 'Failed to fetch funding');
      return reply.code(500).send({ error: e.message });
    }
  });

  // Get open interest
  app.get('/hub/oi/:exchange/:symbol', async (request, reply) => {
    try {
      const hub = getHub();
      const exchange = String(request.params.exchange).toLowerCase();
      const symbol = String(request.params.symbol).toUpperCase();
      const oi = hub.getOpenInterest(exchange, symbol);
      if (!oi) {
        return reply.code(404).send({ error: 'Open interest not found' });
      }
      return oi;
    } catch (e) {
      app.log.error(e, 'Failed to fetch open interest');
      return reply.code(500).send({ error: e.message });
    }
  });

  // Get cached klines (auto-fetches from exchange if cache is too small)
  app.get('/hub/klines/:exchange/:symbol/:interval', async (request, reply) => {
    try {
      const hub = getHub();
      const exchange = String(request.params.exchange).toLowerCase();
      const symbol = String(request.params.symbol).toUpperCase();
      const interval = String(request.params.interval);
      const limit = Math.min(Number(request.query.limit) || 500, 500);
      
      const klines = await hub.getKlinesWithFallback(exchange, symbol, interval, limit);
      return { exchange, symbol, interval, count: klines.length, klines };
    } catch (e) {
      app.log.error(e, 'Failed to fetch klines');
      return reply.code(500).send({ error: e.message });
    }
  });

  // Fetch historical klines (on-demand from exchange)
  app.get('/hub/klines/:exchange/:symbol/:interval/history', async (request, reply) => {
    try {
      const hub = getHub();
      const exchange = String(request.params.exchange).toLowerCase();
      const symbol = String(request.params.symbol).toUpperCase();
      const interval = String(request.params.interval);
      const before = request.query.before ? Number(request.query.before) : null;
      const limit = Math.min(Number(request.query.limit) || 200, 500);
      
      const klines = await hub.fetchKlines(exchange, symbol, interval, limit, before);
      return { exchange, symbol, interval, count: klines.length, klines };
    } catch (e) {
      app.log.error(e, 'Failed to fetch historical klines');
      return reply.code(500).send({ error: e.message });
    }
  });

  // Get liquidations (Bybit only)
  app.get('/hub/liquidations/:exchange/:symbol', async (request, reply) => {
    try {
      const hub = getHub();
      const exchange = String(request.params.exchange).toLowerCase();
      const symbol = String(request.params.symbol).toUpperCase();
      const limit = Math.min(Number(request.query.limit) || 100, 100);
      const liquidations = hub.getLiquidations(exchange, symbol, limit);
      return { exchange, symbol, count: liquidations.length, liquidations };
    } catch (e) {
      app.log.error(e, 'Failed to fetch liquidations');
      return reply.code(500).send({ error: e.message });
    }
  });
};

