// REST API endpoints

const { nanoid } = require('nanoid');
const { ADMIN_TOKEN, ENABLE_TRADE_EVENTS_READ } = require('../config/constants');
const storage = require('../services/storage');

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

  // Get recent news
  app.get('/api/news', async (request, reply) => {
    const limit = Math.min(Number(request.query.limit) || 100, 200);
    try {
      if (storage.pgClient) {
        const result = await storage.pgClient.query(
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
    
    try {
      if (storage.pgClient) {
        const result = await storage.pgClient.query(
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
        const roomMessages = storage.memoryMessages
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
};

