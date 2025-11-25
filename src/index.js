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

// Forwarder logic (kept in main for performance)
const forwarderRoutes = require('./routes/forwarder');
const apiRoutes = require('./routes/api');
const wsRoutes = require('./routes/websocket');

const app = Fastify({ logger: true });
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
    
    // Handle graceful shutdown
    process.on('SIGTERM', () => {
      console.log('SIGTERM received, shutting down...');
      process.exit(0);
    });
    
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();

module.exports = app;
