'use strict';

/**
 * Public Data Hub - Main Orchestrator
 * Manages all exchange connections, caching, and client broadcasting
 */

const BybitAdapter = require('./BybitAdapter');
const BlofinAdapter = require('./BlofinAdapter');
const BitunixAdapter = require('./BitunixAdapter');
const HyperliquidAdapter = require('./HyperliquidAdapter');
const BinanceAdapter = require('./BinanceAdapter');
const StateCache = require('./StateCache');
const RestPoller = require('./RestPoller');
const DemandTracker = require('./DemandTracker');
const RateLimitCoordinator = require('./RateLimitCoordinator');
const RequestDeduplicator = require('./RequestDeduplicator');

const STARTUP_TIMEOUT = 15000; // 15 seconds max to wait for exchanges (reduced from 60s)

class PublicDataHub {
  constructor(options = {}) {
    this.debug = options.debug !== undefined ? options.debug : false; // quiet by default for performance
    this.ready = false;
    this.startupPromise = null;

    // Create cache
    this.cache = new StateCache({ debug: this.debug, staleThreshold: 5 * 60 * 1000 });

    // Create rate limit and deduplication utilities
    this.rateLimit = new RateLimitCoordinator({ debug: this.debug });
    this.deduper = new RequestDeduplicator({ debug: this.debug });

    // Create adapters
    this.adapters = {
      bybit: new BybitAdapter({ debug: this.debug }),
      blofin: new BlofinAdapter({ debug: this.debug }),
      bitunix: new BitunixAdapter({ debug: this.debug }),
      hyperliquid: new HyperliquidAdapter({ debug: this.debug }),
      binance: new BinanceAdapter({ debug: this.debug })
    };

    // Create REST poller
    this.poller = new RestPoller(this.cache, { debug: this.debug, rateLimit: this.rateLimit });

    // Create demand tracker for on-demand subscriptions
    this.demandTracker = new DemandTracker({ debug: this.debug });
    this.demandTracker.setAdapters(this.adapters);

    // Client subscriptions: Map<ws, Set<subscriptionKey>>
    this.clients = new Map();

    // Setup data handlers for each adapter
    this.setupAdapterHandlers();
  }

  log(...args) {
    if (this.debug) console.log('[PublicDataHub]', ...args);
  }

  setupAdapterHandlers() {
    for (const [exchange, adapter] of Object.entries(this.adapters)) {
      adapter.onData((msg) => this.handleAdapterData(msg));
      adapter.onStatus((status) => this.handleAdapterStatus(status));
    }
  }

  handleAdapterData(msg) {
    const { exchange, channel, symbol, data, interval } = msg;

    switch (channel) {
      case 'tickers':
        this.cache.setTicker(exchange, symbol, data);
        break;
      case 'orderbook':
        // Check if it's a snapshot or delta based on data structure
        if (data.bids && data.asks) {
          this.cache.setOrderbook(exchange, symbol, data);
        } else {
          this.cache.updateOrderbook(exchange, symbol, data);
        }
        break;
      case 'trades':
        this.cache.addTrades(exchange, symbol, data);
        // Cache handles notification to subscribed clients
        break;
      case 'liquidations':
        // Cache and notify liquidations
        this.cache.addLiquidation(exchange, symbol, data);
        break;
      case 'klines':
        // Update single kline candle (real-time WS update)
        if (interval && data) {
          this.cache.updateKline(exchange, symbol, interval, data);
          // Cache handles notification to subscribed clients with compound symbol key
        }
        break;
      case 'funding':
        this.cache.setFunding(exchange, symbol, data);
        break;
    }
  }

  handleAdapterStatus(status) {
    this.log(`${status.exchange} status:`, status.connected ? 'CONNECTED' : 'DISCONNECTED');
    this.broadcast({
      type: 'status',
      exchange: status.exchange,
      connected: status.connected
    });
  }

  async start() {
    if (this.startupPromise) return this.startupPromise;

    this.startupPromise = this._doStart();
    return this.startupPromise;
  }

  async _doStart() {
    this.log('Starting Public Data Hub...');

    // Connect all adapters in parallel with individual timeouts
    const connectPromises = Object.entries(this.adapters).map(async ([name, adapter]) => {
      try {
        // Each adapter has 10s to connect (fetchSymbols has 5s timeout + WS connect)
        const connectWithTimeout = Promise.race([
          adapter.connect(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Connection timeout')), 10000))
        ]);
        await connectWithTimeout;
        this.log(`${name} adapter connected`);
        return { name, success: true };
      } catch (e) {
        console.error(`[PublicDataHub] ${name} adapter failed:`, e.message);
        return { name, success: false, error: e.message };
      }
    });

    // Use allSettled - don't wait for all, continue with whatever succeeds
    const startTime = Date.now();
    await Promise.race([
      Promise.allSettled(connectPromises),
      new Promise(resolve => setTimeout(resolve, STARTUP_TIMEOUT))
    ]);
    
    console.log(`[PublicDataHub] Adapter connection phase completed in ${Date.now() - startTime}ms`);

    // Check connection status - continue with whatever is connected
    const connected = Object.entries(this.adapters)
      .filter(([_, a]) => a.isConnected())
      .map(([name]) => name);

    this.log(`Connected exchanges: ${connected.join(', ') || 'none'}`);

    // Start REST poller - AWAIT initial poll to ensure cache is warm before accepting requests
    console.log('[PublicDataHub] Warming up cache with initial REST poll...');
    const pollerStartTime = Date.now();
    try {
      await this.poller.start();
      console.log(`[PublicDataHub] Cache warmed in ${Date.now() - pollerStartTime}ms`);
    } catch (e) {
      console.error('[PublicDataHub] Poller start error:', e.message);
    }

    // Set hot symbols for each connected exchange based on volume (now cache is populated)
    const hotSymbolsMap = {};
    for (const exchange of connected) {
      const topSymbols = this.poller.getTopSymbolsByVolume(exchange, 30);
      if (topSymbols.length > 0) {
        this.demandTracker.setHotSymbols(exchange, topSymbols);
        hotSymbolsMap[exchange] = topSymbols.slice(0, 5); // Top 5 for kline pre-caching
        this.log(`Set ${topSymbols.length} hot symbols for ${exchange}`);
      }
    }

    // Mark as ready even if some exchanges failed (graceful degradation)
    this.ready = connected.length > 0;

    if (this.ready) {
      console.log('✅ Public Data Hub is ready');
      this.log('Hub is ready with hybrid on-demand subscription model');
      
      // Pre-cache klines for top 5 symbols per exchange (non-blocking background task)
      this._precacheTopKlines(hotSymbolsMap).catch(e => 
        console.error('[PublicDataHub] Kline pre-cache error:', e.message)
      );
      
      // Start periodic cleanup of stale cache data (every 10 minutes)
      this.cleanupInterval = setInterval(() => {
        this.cache.cleanupStaleData();
      }, 10 * 60 * 1000);
    } else {
      console.error('[PublicDataHub] Hub started but no exchanges connected');
    }

    return this.ready;
  }

  async stop() {
    this.log('Stopping...');

    // Stop cleanup interval
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    // Stop poller
    this.poller.stop();

    // Cleanup demand tracker
    this.demandTracker.destroy();

    // Close all adapters
    for (const adapter of Object.values(this.adapters)) {
      adapter.close();
    }

    // Clear clients
    this.clients.clear();

    this.ready = false;
    this.log('Stopped');
  }

  // ============= CLIENT MANAGEMENT =============

  addClient(ws) {
    this.clients.set(ws, new Set());
    this.log(`Client connected (total: ${this.clients.size})`);
  }

  removeClient(ws) {
    this.clients.delete(ws);
    this.log(`Client disconnected (total: ${this.clients.size})`);
  }

  handleClientMessage(ws, message) {
    try {
      const msg = typeof message === 'string' ? JSON.parse(message) : message;
      const { action, exchange, channel, symbol } = msg;

      if (this.debug) console.log(`[Hub] 📨 Client message: action=${action}, exchange=${exchange}, channel=${channel}, symbol=${symbol}`);

      if (action === 'subscribe') {
        this.subscribe(ws, exchange, channel, symbol);
      } else if (action === 'unsubscribe') {
        this.unsubscribe(ws, exchange, channel, symbol);
      } else if (action === 'ping') {
        this.sendToClient(ws, { type: 'pong', ts: Date.now() });
      }
    } catch (e) {
      console.error('[PublicDataHub] Invalid client message:', e.message, message);
    }
  }

  subscribe(ws, exchange, channel, symbol) {
    const subKey = `${channel}:${exchange}:${symbol}`;
    const clientSubs = this.clients.get(ws);
    if (!clientSubs) return;

    if (clientSubs.has(subKey)) return; // Already subscribed
    clientSubs.add(subKey);

    // Subscribe to cache updates
    const callback = (msg) => this.sendToClient(ws, msg);
    ws._hubCallbacks = ws._hubCallbacks || {};
    ws._hubCallbacks[subKey] = callback;

    this.cache.subscribe(channel, exchange, symbol, callback);

    // Use DemandTracker for on-demand channels
    this._handleDemandTrackerAction('subscribe', exchange, channel, symbol);
    this.log(`Client subscribed to ${subKey}`);
  }

  unsubscribe(ws, exchange, channel, symbol) {
    const subKey = `${channel}:${exchange}:${symbol}`;
    const clientSubs = this.clients.get(ws);
    if (!clientSubs) return;

    if (!clientSubs.has(subKey)) return;
    clientSubs.delete(subKey);

    // Remove cache subscription
    if (ws._hubCallbacks && ws._hubCallbacks[subKey]) {
      const callback = ws._hubCallbacks[subKey];
      this.cache.unsubscribe(channel, exchange, symbol, callback);
      delete ws._hubCallbacks[subKey];
    }

    // Use DemandTracker for on-demand channels
    this._handleDemandTrackerAction('unsubscribe', exchange, channel, symbol);
    this.log(`Client unsubscribed from ${subKey}`);
  }

  _handleDemandTrackerAction(action, exchange, channel, symbol) {
    const isSub = action === 'subscribe';
    try {
      if (channel === 'orderbook' || channel === 'trades') {
        return isSub ? this.demandTracker.subscribe(exchange, symbol, channel) :
                      this.demandTracker.unsubscribe(exchange, symbol, channel);
      } else if (channel === 'klines') {
        const [sym, interval] = symbol.split(':');
        if (sym && interval) {
          return isSub ? this.demandTracker.subscribeKline(exchange, sym, interval) :
                        this.demandTracker.unsubscribeKline(exchange, sym, interval);
        }
      } else if (channel === 'liquidations') {
        return isSub ? this.demandTracker.subscribeLiquidation(exchange, symbol) :
                      this.demandTracker.unsubscribeLiquidation(exchange, symbol);
      }
    } catch (e) {
      console.error(`[PublicDataHub] DemandTracker action ${action} failed for ${channel}:${exchange}:${symbol}:`, e.message);
    }
  }

  cleanupClient(ws) {
    // Unsubscribe from all
    const clientSubs = this.clients.get(ws);
    
    if (clientSubs) {
      this.log(`Cleaning up ${clientSubs.size} subscriptions for client`);
      // Use a copy to avoid mutation issues during iteration
      const subsToCleanup = Array.from(clientSubs);
      for (const subKey of subsToCleanup) {
        try {
          const parts = subKey.split(':');
          const channel = parts[0];
          const exchange = parts[1];
          const symbol = parts.slice(2).join(':'); // Handle compound symbols like "BTC:1m"
          
          this.unsubscribe(ws, exchange, channel, symbol);
        } catch (e) {
          console.error(`[PublicDataHub] Error cleaning up sub ${subKey}:`, e.message);
        }
      }
    }
    
    // Clear callbacks and metadata
    delete ws._hubCallbacks;
    this.removeClient(ws);
  }

  sendToClient(ws, data) {
    try {
      if (ws.readyState === 1) { // WebSocket.OPEN
        ws.send(JSON.stringify(data));
      } else if (ws.readyState > 1) { // CLOSING or CLOSED
        this.cleanupClient(ws);
      }
    } catch (e) {
      console.error('[PublicDataHub] Send error, cleaning up client:', e.message);
      this.cleanupClient(ws);
    }
  }

  broadcast(data) {
    const msg = JSON.stringify(data);
    
    for (const ws of this.clients.keys()) {
      try {
        if (ws.readyState === 1) {
          ws.send(msg);
        }
      } catch (e) {
        // Ignore send errors
      }
    }
  }

  // ============= REST API HANDLERS =============

  // Get all tickers for an exchange (triggers fetch if cache empty)
  async getTickers(exchange) {
    let tickers = this.cache.getAllTickers(exchange);
    
    // If cache is empty, trigger a fetch for this exchange
    if (tickers.length === 0 && this.ready) {
      this.log(`Cache empty for ${exchange} tickers, triggering fetch...`);
      try {
        await this.poller.pollExchange(exchange);
        tickers = this.cache.getAllTickers(exchange);
      } catch (e) {
        console.error(`[PublicDataHub] Failed to fetch ${exchange} tickers:`, e.message);
      }
    }
    
    return tickers;
  }

  // Get specific ticker
  getTicker(exchange, symbol) {
    return this.cache.getTicker(exchange, symbol);
  }

  // Get orderbook
  getOrderbook(exchange, symbol) {
    return this.cache.getOrderbook(exchange, symbol);
  }

  // Get recent trades
  getTrades(exchange, symbol, limit = 50) {
    return this.cache.getTrades(exchange, symbol, limit);
  }

  // Get instruments
  getInstruments(exchange) {
    return this.cache.getAllInstruments(exchange);
  }

  // Get funding rates
  getFunding(exchange) {
    return this.cache.getAllFunding(exchange);
  }

  // Get open interest
  getOpenInterest(exchange, symbol) {
    return this.cache.getOpenInterest(exchange, symbol);
  }

  // Get klines
  getKlines(exchange, symbol, interval, limit = 500) {
    return this.cache.getKlines(exchange, symbol, interval, limit);
  }

  // Get klines with automatic fallback to exchange fetch if cache is sparse
  async getKlinesWithFallback(exchange, symbol, interval, limit = 500) {
    let klines = this.getKlines(exchange, symbol, interval, limit);
    
    // If cache has too few klines (<50), fetch from exchange
    if (klines.length < 50) {
      try {
        const fetched = await this.fetchKlines(exchange, symbol, interval, limit, null);
        if (fetched && fetched.length > 0) {
          klines = fetched;
        }
      } catch (e) {
        this.log(`Fallback fetch failed for ${exchange}/${symbol}:`, e.message);
      }
    }
    return klines;
  }

  // Get klines before a timestamp (for historical loading)
  getKlinesBefore(exchange, symbol, interval, before, limit = 200) {
    return this.cache.getKlinesBefore(exchange, symbol, interval, before, limit);
  }

  // Fetch historical klines via REST (on-demand)
  async fetchKlines(exchange, symbol, interval, limit = 200, before = null) {
    const key = `${exchange}:klines:${symbol}:${interval}:${before || 'now'}`;
    
    return this.deduper.execute(key, async () => {
      // Check rate limit before calling poller
      if (this.rateLimit && !this.rateLimit.canRequest(exchange)) {
        return [];
      }
      
      if (this.rateLimit) this.rateLimit.recordRequest(exchange);
      
      try {
        const candles = await this.poller.fetchKlines(exchange, symbol, interval, limit, before);
        return candles;
      } catch (e) {
        if (this.rateLimit && e.message.includes('429')) {
          this.rateLimit.reportRateLimit(exchange);
        }
        throw e;
      }
    });
  }

  // Get liquidations
  getLiquidations(exchange, symbol, limit = 100) {
    return this.cache.getLiquidations(exchange, symbol, limit);
  }

  // ============= KLINE PRE-CACHING =============

  /**
   * Pre-cache klines for top symbols to ensure instant chart loads
   * Called on startup in background (non-blocking)
   */
  async _precacheTopKlines(hotSymbolsMap) {
    const intervals = ['1', '15', '60', 'D']; // 1m, 15m, 1h, 1D - most common
    const startTime = Date.now();
    let cached = 0;
    
    console.log('[PublicDataHub] Pre-caching klines for top symbols...');
    
    for (const [exchange, symbols] of Object.entries(hotSymbolsMap)) {
      if (!symbols || symbols.length === 0) continue;
      
      // Pre-cache only 1m and 15m for top 3 symbols to avoid rate limits
      const topSymbols = symbols.slice(0, 3);
      const quickIntervals = ['1', '15'];
      
      for (const symbol of topSymbols) {
        for (const interval of quickIntervals) {
          try {
            // Small delay between fetches to avoid rate limiting
            await new Promise(r => setTimeout(r, 100));
            
            const klines = await this.poller.fetchKlines(exchange, symbol, interval, 200);
            if (klines.length > 0) {
              cached++;
            }
          } catch (e) {
            // Silently skip failures - this is just optimization
            this.log(`Pre-cache failed for ${exchange}/${symbol}/${interval}:`, e.message);
          }
        }
      }
    }
    
    console.log(`[PublicDataHub] ✅ Pre-cached ${cached} kline sets in ${Date.now() - startTime}ms`);
  }

  // ============= HEALTH =============

  getHealth() {
    const exchangeStatus = {};

    for (const [name, adapter] of Object.entries(this.adapters)) {
      const stats = this.cache.getExchangeStats(name);
      exchangeStatus[name] = {
        connected: adapter.isConnected(),
        symbols: adapter.getSymbolCount(),
        lastUpdate: adapter.getLastUpdate(),
        cache: stats
      };
    }

    const allConnected = Object.values(exchangeStatus).every(e => e.connected);
    const someConnected = Object.values(exchangeStatus).some(e => e.connected);

    return {
      status: allConnected ? 'healthy' : someConnected ? 'degraded' : 'down',
      ready: this.ready,
      uptime: process.uptime(),
      exchanges: exchangeStatus,
      clients: this.clients.size,
      cache: this.cache.getStats(),
      demandTracker: this.demandTracker.getStats(),
      timestamp: Date.now()
    };
  }
}

// Singleton instance
let instance = null;

function getHub(options) {
  if (!instance) {
    instance = new PublicDataHub(options);
  }
  return instance;
}

module.exports = { PublicDataHub, getHub };

