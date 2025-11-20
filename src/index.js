'use strict';

// Crypto Legends Chat Server - Refactored
// Main entry point with modular architecture

const Fastify = require('fastify');
const fastifyCors = require('@fastify/cors');
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

// Healthcheck endpoints
app.get('/health', async () => ({ ok: true }));
app.get('/version', async () => ({ name: 'crypto-legends-chat-server', version: '0.1.1' }));

// Image proxy test page
app.get('/test-img-proxy', async (req, reply) => {
  const html = `<!DOCTYPE html>
<html>
<head>
  <title>Image Proxy Test</title>
  <style>
    body { background: #0e0e0e; color: #fff; font-family: monospace; padding: 20px; }
    .test { margin: 20px 0; display: flex; align-items: center; gap: 20px; }
    img { width: 48px; height: 48px; border: 1px solid #333; border-radius: 4px; }
    .status { font-size: 12px; }
    .ok { color: #1BC47D; }
    .error { color: #FF5356; }
  </style>
</head>
<body>
  <h1>✅ Image Proxy Test</h1>
  <p>These images are being proxied through /img-proxy to bypass tracking protection:</p>
  
  <div class="test">
    <img id="img1" src="/img-proxy?url=https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png" alt="Twitter Default">
    <div class="status"><span class="ok">✓ Twitter Default Profile</span></div>
  </div>

  <div class="test">
    <img id="img2" src="/img-proxy?url=https://ton.twitter.com/1.1/ton/data/dm_polling_light_mode/2e88cf0dbd98435fa8f1cf2e1e64b5e2.png" alt="Twitter Icon">
    <div class="status"><span class="ok">✓ Twitter Icon</span></div>
  </div>

  <script>
    document.querySelectorAll('img').forEach(img => {
      img.addEventListener('load', () => {
        console.log('✅ Loaded:', img.src);
      });
      img.addEventListener('error', () => {
        console.error('❌ Failed:', img.src);
      });
    });
  </script>
</body>
</html>`;
  reply.type('text/html').send(html);
});

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
