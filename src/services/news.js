// News aggregation and external source connections

const WebSocket = require('ws');
const { nanoid } = require('nanoid');
const { pickFirst } = require('../middleware/validation');
const { NEWS_SOURCES, BWE_URL, BWE_PING_INTERVAL, BWE_RECONNECT_DELAY } = require('../config/constants');

let app = null; // Will be set by main
let newsClients = new Set();
let volatilityClients = new Set();

function setApp(fastifyApp) {
  app = fastifyApp;
}

function setClients(news, volatility) {
  newsClients = news;
  volatilityClients = volatility;
}

// Normalize message from Phoenix/Tree News
function normalizePhoenix(msg) {
  try {
    const text = pickFirst(msg?.text, msg?.body, msg?.title);

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
      msg?.sourceUsername,
      msg?.sourceName
    );
    if (username && username.startsWith('@')) username = username.slice(1);

    if (!username && msg?.title) {
      const match = msg.title.match(/@(\w+)/);
      if (match) username = match[1];
    }

    let name = pickFirst(
      msg?.name,
      msg?.displayName,
      msg?.user?.name,
      msg?.author?.name,
      msg?.source_name,
      msg?.sourceName,
      msg?.source
    );

    if (!name && msg?.title) {
      const titleName = msg.title.split('(')[0]?.trim();
      if (titleName) name = titleName;
    }

    const icon = pickFirst(
      msg?.icon,
      msg?.banner,
      msg?.user?.profile_image_url,
      msg?.user?.profile_image_url_https,
      msg?.profile_image_url,
      msg?.profileImageUrl
    ) || null;

    const url = pickFirst(msg?.url, msg?.tweetUrl, msg?.link) || null;
    const createdAt = msg?.createdAt || msg?.receivedAt || Date.now();

    const coin = pickFirst(msg?.coin, msg?.symbol, (Array.isArray(msg?.symbols) && msg.symbols[0]));
    const symbols = Array.isArray(msg?.symbols) ? msg.symbols : (coin ? [coin] : []);

    return {
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
  } catch (_) {
    return null;
  }
}

// Broadcast news item to connected clients (LEAN version - removes detectedTokens)
function broadcastNewsItem(item) {
  try {
    // Send only essential fields to reduce bandwidth by ~30%
    const leanItem = {
      id: item.id,
      username: item.username,
      name: item.name,
      text: item.text,
      createdAt: item.createdAt,
      url: item.url,
      symbols: item.symbols || []
      // Removed: receivedAt, followers, images, isRetweet, isQuote, isReply, coin, icon
    };
    const data = JSON.stringify({ item: leanItem });
    for (const client of newsClients) {
      try {
        client.send(data);
      } catch (_) { }
    }
  } catch (_) { }
}

// Broadcast volatility alert
function broadcastVolatilityAlert(alert) {
  try {
    const data = JSON.stringify({ type: 'alert', alert });
    for (const client of volatilityClients) {
      try {
        client.send(data);
      } catch (_) { }
    }
    console.log('[Volatility] Broadcasted alert:', alert.symbol, alert.changePercent + '%');
  } catch (e) {
    if (app) app.log.error(e, 'Failed to broadcast volatility alert');
  }
}

// Push news item and broadcast
function pushNews(item, pgClient, memoryNews) {
  if (!item || !item.text) return;

  try {
    const idStr = String(item.id);
    const exists = memoryNews.some(m => String(m.id) === idStr);
    if (exists) return;
  } catch (_) { }

  memoryNews.push(item);
  // In-place mutation to prevent unbounded growth
  if (memoryNews.length > 1000) {
    memoryNews.splice(0, memoryNews.length - 1000);
  }

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
      ).catch((e) => {
        if (app) app.log.error(e, 'news_items insert error');
      });
    } catch (e) {
      if (app) app.log.error(e, 'news_items persist error');
    }
  }

  broadcastNewsItem(item);
}

// Connect to external news sources
function connectExternalSources(pgClient, memoryNews) {
  const sources = NEWS_SOURCES;
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
        if (app) app.log.info(`${source.name} connected`);
      });

      ws.on('message', (buf) => {
        const dataStr = buf.toString();
        try {
          const data = JSON.parse(dataStr);
          const candidates = [];
          const primary = normalizePhoenix(data);
          if (primary) candidates.push(primary);
          if (Array.isArray(data?.data)) {
            data.data.forEach((d) => {
              const m = normalizePhoenix(d);
              if (m) candidates.push(m);
            });
          }
          candidates.forEach((n) => pushNews(n, pgClient, memoryNews));
        } catch (_) { }
      });

      ws.on('error', (e) => {
        if (app) app.log.error(`${source.name} error: ${e?.message || e}`);
      });

      ws.on('close', () => {
        if (app) app.log.warn(`${source.name} closed, reconnecting soon`);
        endpointIndex.set(source.name, (idx + 1) % Math.max(1, urls.length));
        setTimeout(() => connect(source), 3000);
      });
    } catch (e) {
      if (app) app.log.error(e, `${source.name} connect failed`);
      setTimeout(() => connect(source), 3000);
    }
  };

  sources.forEach(connect);
}

// Helper function to parse time period from various formats
function parseTimePeriod(value) {
  if (typeof value === 'number') {
    return value; // Assume it's already in seconds
  }
  if (typeof value === 'string') {
    // Parse strings like "30s", "1m", "5m", "1h", etc.
    const match = value.match(/^(\d+)([smh])?$/i);
    if (match) {
      const num = parseInt(match[1]);
      const unit = (match[2] || 's').toLowerCase();
      if (unit === 's') return num;
      if (unit === 'm') return num * 60;
      if (unit === 'h') return num * 3600;
      return num; // Default to seconds
    }
    // Try to parse as number
    const parsed = parseInt(value);
    if (!isNaN(parsed)) return parsed;
  }
  return 30; // Default to 30 seconds
}

// Connect to BWE for volatility alerts
function connectBWE(pgClient, memoryVolatilityAlerts) {
  try {
    const ws = new WebSocket(BWE_URL);
    let pingInterval;

    ws.on('open', () => {
      if (app) app.log.info('[BWE] Connected to volatility alerts');
      console.log('[BWE] Connected successfully');

      pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send('ping');
        }
      }, BWE_PING_INTERVAL);
    });

    ws.on('message', (buf) => {
      try {
        const raw = buf.toString();
        if (raw === 'pong') return;

        if (!ws._firstMessageLogged) {
          console.log('[BWE] First alert received:', raw.slice(0, 500));
          ws._firstMessageLogged = true;
        }

        let data;
        try {
          data = JSON.parse(raw);
        } catch (parseError) {
          console.log('[BWE] Non-JSON alert:', raw.slice(0, 200));
          return;
        }

        const alerts = Array.isArray(data) ? data : [data];

        for (const item of alerts) {
          if (!item || typeof item !== 'object') continue;

          let symbol = null;
          let changePercent = 0;

          if (item.title) {
            const match = item.title.match(/([A-Z0-9]+USDT)\s*\([A-Z0-9]+\)\s*([-+]?\d+\.?\d*)%/);
            if (match) {
              symbol = match[1];
              changePercent = parseFloat(match[2]);
            }
          }

          if (!symbol) {
            symbol = item.symbol || item.coin || (Array.isArray(item.coins_included) && item.coins_included[0]) || null;
          }

          if (!symbol) {
            console.log('[BWE] Could not extract symbol from:', JSON.stringify(item).slice(0, 200));
            continue;
          }

          // Extract time period from various possible fields
          // Try: timeframe, period, duration, interval, time_period, or parse from title
          let timePeriod = 30; // Default to 30 seconds
          if (item.timeframe !== undefined) {
            timePeriod = parseTimePeriod(item.timeframe);
          } else if (item.period !== undefined) {
            timePeriod = parseTimePeriod(item.period);
          } else if (item.duration !== undefined) {
            timePeriod = parseTimePeriod(item.duration);
          } else if (item.interval !== undefined) {
            timePeriod = parseTimePeriod(item.interval);
          } else if (item.time_period !== undefined) {
            timePeriod = parseTimePeriod(item.time_period);
          } else if (item.title) {
            // Try to parse from title like "in the past 3 seconds", "in 30s", "in 1m", etc.
            // First try: "in the past X seconds/minutes/hours" format
            const longMatch = item.title.match(/(?:in\s+the\s+past|past)\s+(\d+)\s*(second|minute|hour|sec|min)s?/i);
            if (longMatch) {
              const value = parseInt(longMatch[1]);
              const unit = longMatch[2].toLowerCase();
              if (unit === 'second' || unit === 'sec') timePeriod = value;
              else if (unit === 'minute' || unit === 'min') timePeriod = value * 60;
              else if (unit === 'hour') timePeriod = value * 3600;
            } else {
              // Fallback: short form like "in 30s", "in 1m", "in 5m"
              const shortMatch = item.title.match(/in\s+(\d+)([smh])/i);
              if (shortMatch) {
                const value = parseInt(shortMatch[1]);
                const unit = shortMatch[2].toLowerCase();
                if (unit === 's') timePeriod = value;
                else if (unit === 'm') timePeriod = value * 60;
                else if (unit === 'h') timePeriod = value * 3600;
              }
            }
          }

          const alert = {
            id: nanoid(),
            symbol: String(symbol).toUpperCase(),
            exchange: item.exchange || 'BWE',
            price: Number(item.price || item.last_price || item.firstPrice?.price || 0),
            changePercent: changePercent || Number(item.changePercent || item.change_percent || item.change || item.percent_change || 0),
            volume: Number(item.volume || item.volume_24h || 0),
            type: item.type || item.alert_type || 'VOLATILITY',
            timestamp: item.time || item.timestamp || Date.now(),
            timePeriod: timePeriod
          };

          console.log('[BWE] New alert:', alert.symbol, (alert.changePercent > 0 ? '+' : '') + alert.changePercent + '%', 'in', alert.timePeriod + 's');
          pushVolatilityAlert(alert, pgClient, memoryVolatilityAlerts);
        }
      } catch (e) {
        if (app) app.log.error(e, '[BWE] Error processing message');
      }
    });

    ws.on('error', (e) => {
      if (app) app.log.error(`[BWE] Error: ${e?.message || e}`);
    });

    ws.on('close', () => {
      if (pingInterval) clearInterval(pingInterval);
      if (app) app.log.warn('[BWE] Connection closed, reconnecting in 5s');
      setTimeout(() => connectBWE(pgClient, memoryVolatilityAlerts), BWE_RECONNECT_DELAY);
    });
  } catch (e) {
    if (app) app.log.error(e, '[BWE] Failed to connect');
    setTimeout(() => connectBWE(pgClient, memoryVolatilityAlerts), BWE_RECONNECT_DELAY);
  }
}

// Push volatility alert
function pushVolatilityAlert(alert, pgClient, memoryVolatilityAlerts) {
  if (!alert || !alert.symbol) return;

  const alertData = {
    id: alert.id || nanoid(),
    symbol: String(alert.symbol).toUpperCase().slice(0, 20),
    exchange: String(alert.exchange || 'UNKNOWN').toUpperCase().slice(0, 20),
    price: Number(alert.price) || 0,
    change_percent: Number(alert.changePercent) || 0,
    volume: Number(alert.volume) || 0,
    alert_type: String(alert.type || 'VOLATILITY').slice(0, 20),
    timestamp: alert.timestamp || Date.now(),
    time_period: Number(alert.timePeriod) || 30 // Time period in seconds, default to 30
  };

  memoryVolatilityAlerts.push(alertData);
  // In-place mutation - assignment doesn't work on passed array reference
  if (memoryVolatilityAlerts.length > 100) {
    memoryVolatilityAlerts.splice(0, memoryVolatilityAlerts.length - 100);
  }

  if (pgClient) {
    try {
      pgClient.query(
        `INSERT INTO volatility_alerts (id, symbol, exchange, price, change_percent, volume, alert_type, time_period, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (id) DO NOTHING`,
        [
          alertData.id,
          alertData.symbol,
          alertData.exchange,
          alertData.price,
          alertData.change_percent,
          alertData.volume,
          alertData.alert_type,
          alertData.time_period,
          new Date(alertData.timestamp).toISOString()
        ]
      );
    } catch (e) {
      if (app) app.log.error(e, 'Failed to persist volatility alert');
    }
  }

  broadcastVolatilityAlert({
    id: alertData.id,
    symbol: alertData.symbol,
    exchange: alertData.exchange,
    price: alertData.price,
    changePercent: alertData.change_percent,
    volume: alertData.volume,
    type: alertData.alert_type,
    timestamp: alertData.timestamp,
    timePeriod: alertData.time_period
  });
}

module.exports = {
  setApp,
  setClients,
  normalizePhoenix,
  broadcastNewsItem,
  broadcastVolatilityAlert,
  pushNews,
  connectExternalSources,
  connectBWE,
  pushVolatilityAlert
};

