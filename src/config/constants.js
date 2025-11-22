// Configuration constants for the backend

const https = require('https');
const http = require('http');

// Environment configuration
module.exports = {
  PORT: process.env.PORT || 8080,
  DATABASE_URL: process.env.DATABASE_URL || process.env.POSTGRES_URL || '',
  ADMIN_TOKEN: process.env.ADMIN_TOKEN || '',
  ENABLE_TRADE_EVENTS_READ: String(process.env.ENABLE_TRADE_EVENTS_READ || 'false').toLowerCase() === 'true',
  // Some upstreams (Blofin) are slow to respond; give them more time by default
  UPSTREAM_TIMEOUT_MS: Number(process.env.UPSTREAM_TIMEOUT_MS || 15000),
  
  // CORS origins configuration
  getAllowedOrigins: () => {
    const envOrigin = process.env.CORS_ORIGIN;
    if (envOrigin) {
      return envOrigin.split(',').map(origin => origin.trim());
    }
    
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
  },
  
  // Upstream forwarder configuration
  ALLOWED_UPSTREAMS: new Set([
    'openapi.blofin.com',
    'fapi.bitunix.com',
    'api.bitunix.com',
    'gamma-api.polymarket.com'
  ]),
  
  BLOFIN_ALLOWED_HEADERS: new Set([
    'access-key','access-sign','access-timestamp','access-passphrase','access-nonce','broker-id','content-type'
  ]),
  
  BITUNIX_ALLOWED_HEADERS: new Set([
    'api-key','sign','timestamp','nonce','content-type'
  ]),
  
  POLYMARKET_ALLOWED_HEADERS: new Set([
    'content-type','accept','accept-language'
  ]),
  
  // HTTP/HTTPS agents for connection pooling
  httpsAgent: new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 30000,
    maxSockets: 100,
    maxFreeSockets: 10,
    timeout: 15000,
    scheduling: 'fifo'
  }),
  
  httpAgent: new http.Agent({
    keepAlive: true,
    keepAliveMsecs: 30000,
    maxSockets: 100,
    maxFreeSockets: 10,
    timeout: 15000,
    scheduling: 'fifo'
  }),
  
  // News sources
  NEWS_SOURCES: [
    { name: 'TreeOfAlpha', urls: ['wss://news.treeofalpha.com/ws'] },
    { name: 'PhoenixNews', urls: ['wss://wss.phoenixnews.io'] }
  ],
  
  // BWE configuration
  BWE_URL: 'ws://public.bwe-ws.com:8001/',
  BWE_PING_INTERVAL: 8000,
  BWE_RECONNECT_DELAY: 5000,
  
  // Rate limiting
  RATE_LIMIT_WINDOW: 60000, // 1 minute
  RATE_LIMIT_MAX_MESSAGES: 30 // Max messages per minute
};

