'use strict';

// Crypto Legends Chat Server - Refactored
// Main entry point with modular architecture

const Fastify = require('fastify');
const fastifyCors = require('@fastify/cors');
const fastifyCompress = require('@fastify/compress');
const fastifyWebsocket = require('@fastify/websocket');
const { nanoid } = require('nanoid');

const config = require('./config/constants');
const { sanitizeInput, sanitizeName, checkRateLimit, cleanupRateLimit, pickHeaders, buildUpstreamUrl, pickFirst } = require('./middleware/validation');
const storage = require('./services/storage');
const news = require('./services/news');
const { getHub } = require('./services/hub/PublicDataHub');

// Forwarder logic (kept in main for performance)
const forwarderRoutes = require('./routes/forwarder');
const apiRoutes = require('./routes/api');
const wsRoutes = require('./routes/websocket');

const app = Fastify({ 
  logger: true,
  connectionTimeout: 10000,  // 10s to establish connection
  requestTimeout: 20000      // 20s max per request
});
app.register(fastifyWebsocket);

// CORS setup
app.register(fastifyCors, {
  origin: (origin, callback) => {
    const allowed = config.getAllowedOrigins();
    if (!origin) {
      callback(null, true);
      return;
    }
    if (allowed.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'), false);
    }
  },
  credentials: true 
});

// Response compression (br/gzip/deflate) with 1KB threshold
app.register(fastifyCompress, {
  global: true,
  encodings: ['br', 'gzip', 'deflate'],
  threshold: 1024
});

// Global error handler
app.setErrorHandler((error, request, reply) => {
  app.log.error(`❌ [${request.method} ${request.url}] Error:`, error.message);
  reply.status(error.statusCode || 500).send({
    error: true,
    message: error.message || 'Internal server error',
    path: request.url,
    method: request.method
  });
});

// Healthcheck endpoints
app.get('/health', async () => ({ ok: true }));
app.get('/version', async () => ({ name: 'crypto-legends-chat-server', version: '0.1.1' }));

// Register route modules
forwarderRoutes(app);
apiRoutes(app);
wsRoutes(app);

// Initialize and start
async function start() {
  try {
    // Load data
    storage.loadMessages();
    storage.loadNews();
    
    // Initialize database
    await storage.initPostgres().catch(() => {});
    
    // Setup news service
    news.setApp(app);
    
    // Listen
    await app.listen({ port: Number(config.PORT), host: '0.0.0.0' });
    
    console.log(`🚀 Chat server v0.1.1 running on :${config.PORT}`);
    console.log(`📡 CORS origins: ${JSON.stringify(config.getAllowedOrigins())}`);
    
    // Start external services
    news.connectExternalSources(storage.pgClient, storage.memoryNews);
    news.connectBWE(storage.pgClient, storage.memoryVolatilityAlerts);
    
    // Initialize Public Data Hub (non-blocking - server is already listening)
    console.log('🔌 Initializing Public Data Hub (non-blocking)...');
    const hub = getHub({ debug: false });
    
    // Fire and forget - hub will be ready when ready, server is already accepting requests
    hub.start().then(ready => {
      if (ready) {
        console.log('✅ Public Data Hub is ready');
      } else {
        console.warn('⚠️ Public Data Hub started but may be degraded');
      }
    }).catch(err => {
      console.error('❌ Public Data Hub failed to start:', err.message);
    });
    
    // Memory monitoring - log heap usage every 5 minutes
    setInterval(() => {
      const used = process.memoryUsage();
      const heapUsedMB = Math.round(used.heapUsed / 1024 / 1024);
      const heapTotalMB = Math.round(used.heapTotal / 1024 / 1024);
      const rssMB = Math.round(used.rss / 1024 / 1024);
      console.log(`[Memory] Heap: ${heapUsedMB}/${heapTotalMB}MB, RSS: ${rssMB}MB`);
    }, 5 * 60 * 1000);
    
    // Handle graceful shutdown
    process.on('SIGTERM', () => {
      console.log('SIGTERM received, shutting down...');
      hub.stop();
      process.exit(0);
    });

    process.on('SIGINT', () => {
      console.log('SIGINT received, shutting down...');
      hub.stop();
      process.exit(0);
    });
    
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();

module.exports = app;
