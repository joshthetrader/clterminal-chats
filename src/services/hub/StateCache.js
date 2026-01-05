'use strict';

/**
 * State Cache for Public Data Hub
 * In-memory storage for all public market data with TTL support
 */

const DEFAULT_STALE_THRESHOLD = 5 * 60 * 1000; // 5 minutes

class StateCache {
  constructor(options = {}) {
    this.staleThreshold = options.staleThreshold || DEFAULT_STALE_THRESHOLD;
    this.debug = options.debug || false;

    // Main data stores
    this.tickers = new Map();
    this.orderbooks = new Map();
    this.trades = new Map();
    this.instruments = new Map();
    this.funding = new Map();
    this.openInterest = new Map();
    this.klines = new Map(); // key: exchange:symbol:interval, value: array of candles
    this.liquidations = new Map(); // key: exchange:symbol, value: array of 100 liquidations

    // Registry for easier iteration and stats
    this._collections = [
      'tickers', 'orderbooks', 'trades', 'instruments', 
      'funding', 'openInterest', 'klines', 'liquidations'
    ];

    // Metadata
    this.lastUpdate = new Map();
    this.subscribers = new Map(); // key -> Set of callbacks
  }

  log(...args) {
    if (this.debug) console.log('[StateCache]', ...args);
  }

  // Generate consistent key for data
  key(exchange, symbol) {
    return `${exchange}:${symbol}`;
  }

  /**
   * Generic internal setter for standard collections
   * @private
   */
  _set(collectionName, exchange, symbol, data, shouldNotify = true) {
    const k = this.key(exchange, symbol);
    const collection = this[collectionName];
    if (!collection) return;

    const existing = collection.get(k) || {};
    
    // Merge for tickers to preserve fields, replace for others
    const updated = collectionName === 'tickers' 
      ? { ...existing, ...data, _exchange: exchange, _symbol: symbol }
      : { ...data, _exchange: exchange, _symbol: symbol };

    collection.set(k, updated);
    this.lastUpdate.set(`${collectionName}:${k}`, Date.now());
    
    if (shouldNotify) {
      this.notify(collectionName, exchange, symbol, updated);
    }
  }

  /**
   * Generic internal getter for standard collections
   * @private
   */
  _get(collectionName, exchange, symbol) {
    const k = this.key(exchange, symbol);
    const data = this[collectionName]?.get(k);
    if (!data) return null;
    
    if (this.isStale(`${collectionName}:${k}`)) {
      return { ...data, _stale: true };
    }
    return data;
  }

  // ============= TICKERS =============

  setTicker(exchange, symbol, data) {
    this._set('tickers', exchange, symbol, data);
  }

  getTicker(exchange, symbol) {
    return this._get('tickers', exchange, symbol);
  }

  getAllTickers(exchange) {
    return Array.from(this.tickers.values()).filter(v => v._exchange === exchange);
  }

  getTickers(exchange) {
    return this.getAllTickers(exchange);
  }

  // ============= ORDERBOOK =============

  setOrderbook(exchange, symbol, data) {
    this._set('orderbooks', exchange, symbol, data);
  }

  updateOrderbook(exchange, symbol, delta) {
    const k = this.key(exchange, symbol);
    const existing = this.orderbooks.get(k);
    
    if (!existing) {
      this.setOrderbook(exchange, symbol, delta);
      return;
    }

    // Apply delta updates
    const bidsMap = new Map(existing.bids || []);
    const asksMap = new Map(existing.asks || []);

    const applyUpdates = (map, updates) => {
      if (!updates) return;
      for (const [price, qty] of updates) {
        if (qty === 0) map.delete(price);
        else map.set(price, qty);
      }
    };

    applyUpdates(bidsMap, delta.bids);
    applyUpdates(asksMap, delta.asks);

    const updated = {
      ...existing,
      bids: [...bidsMap.entries()].sort((a, b) => b[0] - a[0]),
      asks: [...asksMap.entries()].sort((a, b) => a[0] - b[0]),
      updateId: delta.updateId || existing.updateId,
      timestamp: delta.timestamp || Date.now()
    };

    this._set('orderbooks', exchange, symbol, updated);
  }

  getOrderbook(exchange, symbol) {
    return this._get('orderbooks', exchange, symbol);
  }

  // ============= TRADES =============

  addTrades(exchange, symbol, trades) {
    const k = this.key(exchange, symbol);
    const existing = this.trades.get(k) || [];
    
    // Build a dedup set from existing trades using tradeId OR composite key (price:size:timestamp)
    const seenKeys = new Set();
    for (const ext of existing) {
      if (ext.tradeId) {
        seenKeys.add(`id:${ext.tradeId}`);
      }
      // Also add composite key for fallback matching
      if (ext.price != null && ext.size != null && ext.timestamp != null) {
        seenKeys.add(`${ext.price}:${ext.size}:${ext.timestamp}`);
      }
    }
    
    // Filter out trades that already exist in cache
    const newTrades = trades.filter(t => {
      // Check by tradeId first
      if (t.tradeId && seenKeys.has(`id:${t.tradeId}`)) {
        return false;
      }
      // Fallback to composite key (price:size:timestamp)
      if (t.price != null && t.size != null && t.timestamp != null) {
        const compositeKey = `${t.price}:${t.size}:${t.timestamp}`;
        if (seenKeys.has(compositeKey)) {
          return false;
        }
        // Add to seen so we don't duplicate within same batch
        seenKeys.add(compositeKey);
        if (t.tradeId) seenKeys.add(`id:${t.tradeId}`);
      }
      return true;
    });

    if (newTrades.length === 0) return;

    // Keep last 100 trades
    const combined = [...newTrades, ...existing].slice(0, 100);
    this.trades.set(k, combined);
    this.lastUpdate.set(`trades:${k}`, Date.now());
    this.notify('trades', exchange, symbol, newTrades);
  }

  getTrades(exchange, symbol, limit = 50) {
    const k = this.key(exchange, symbol);
    const data = this.trades.get(k);
    if (!data) return [];
    return data.slice(0, limit);
  }

  // ============= INSTRUMENTS =============

  setInstruments(exchange, instruments) {
    for (const inst of instruments) {
      const symbol = inst.symbol || inst.instId;
      if (symbol) {
        this._set('instruments', exchange, symbol, inst, false);
      }
    }
    this.lastUpdate.set(`instruments:${exchange}`, Date.now());
    this.log(`Set ${instruments.length} instruments for ${exchange}`);
  }

  getInstrument(exchange, symbol) {
    return this._get('instruments', exchange, symbol);
  }

  getAllInstruments(exchange) {
    return Array.from(this.instruments.values()).filter(v => v._exchange === exchange);
  }

  // ============= FUNDING =============

  setFunding(exchange, symbol, data) {
    this._set('funding', exchange, symbol, data);
  }

  getFunding(exchange, symbol) {
    return this._get('funding', exchange, symbol);
  }

  getAllFunding(exchange) {
    return Array.from(this.funding.values()).filter(v => v._exchange === exchange);
  }

  // ============= OPEN INTEREST =============

  setOpenInterest(exchange, symbol, data) {
    this._set('openInterest', exchange, symbol, data);
  }

  getOpenInterest(exchange, symbol) {
    return this._get('openInterest', exchange, symbol);
  }

  // ============= KLINES =============

  klineKey(exchange, symbol, interval) {
    return `${exchange}:${symbol}:${interval}`;
  }

  setKlines(exchange, symbol, interval, candles) {
    const k = this.klineKey(exchange, symbol, interval);
    // Keep max 500 candles, sorted by time ascending
    const sorted = [...candles].sort((a, b) => a.t - b.t).slice(-500);
    this.klines.set(k, sorted);
    this.lastUpdate.set(`klines:${k}`, Date.now());
    this.notify('klines', exchange, `${symbol}:${interval}`, sorted);
  }

  updateKline(exchange, symbol, interval, candle) {
    const k = this.klineKey(exchange, symbol, interval);
    const existing = this.klines.get(k) || [];
    
    const idx = existing.findIndex(c => c.t === candle.t);
    if (idx >= 0) {
      existing[idx] = candle;
    } else {
      existing.push(candle);
      existing.sort((a, b) => a.t - b.t);
      if (existing.length > 500) existing.shift();
    }
    
    this.klines.set(k, existing);
    this.lastUpdate.set(`klines:${k}`, Date.now());
    this.notify('klines', exchange, `${symbol}:${interval}`, candle);
  }

  getKlines(exchange, symbol, interval, limit = 500) {
    const k = this.klineKey(exchange, symbol, interval);
    const data = this.klines.get(k);
    if (!data) return [];
    return data.slice(-limit);
  }

  getKlinesBefore(exchange, symbol, interval, before, limit = 200) {
    const k = this.klineKey(exchange, symbol, interval);
    const data = this.klines.get(k);
    if (!data) return [];
    const filtered = data.filter(c => c.t < before);
    return filtered.slice(-limit);
  }

  // ============= LIQUIDATIONS =============

  addLiquidation(exchange, symbol, liquidation) {
    // Store under specific symbol
    const k = this.key(exchange, symbol);
    const existing = this.liquidations.get(k) || [];
    existing.unshift(liquidation);
    if (existing.length > 100) existing.pop();
    this.liquidations.set(k, existing);
    this.lastUpdate.set(`liquidations:${k}`, Date.now());
    
    // Also store under "ALL" for aggregate subscribers
    const allKey = this.key(exchange, 'ALL');
    const allExisting = this.liquidations.get(allKey) || [];
    allExisting.unshift(liquidation);
    if (allExisting.length > 100) allExisting.pop();
    this.liquidations.set(allKey, allExisting);
    this.lastUpdate.set(`liquidations:${allKey}`, Date.now());
    
    // Notify specific symbol subscribers
    this.notify('liquidations', exchange, symbol, liquidation);
    // Notify "ALL" subscribers
    this.notify('liquidations', exchange, 'ALL', liquidation);
  }

  addLiquidations(exchange, symbol, liquidations) {
    const k = this.key(exchange, symbol);
    const existing = this.liquidations.get(k) || [];
    const combined = [...liquidations, ...existing].slice(0, 100);
    this.liquidations.set(k, combined);
    this.lastUpdate.set(`liquidations:${k}`, Date.now());
    
    // Also store under "ALL"
    const allKey = this.key(exchange, 'ALL');
    const allExisting = this.liquidations.get(allKey) || [];
    const allCombined = [...liquidations, ...allExisting].slice(0, 100);
    this.liquidations.set(allKey, allCombined);
    this.lastUpdate.set(`liquidations:${allKey}`, Date.now());
    
    this.notify('liquidations', exchange, symbol, liquidations);
    this.notify('liquidations', exchange, 'ALL', liquidations);
  }

  getLiquidations(exchange, symbol, limit = 100) {
    const k = this.key(exchange, symbol);
    const data = this.liquidations.get(k);
    if (!data) return [];
    return data.slice(0, limit);
  }

  // ============= SUBSCRIPTIONS =============

  subscribe(channel, exchange, symbol, callback) {
    const subKey = `${channel}:${exchange}:${symbol}`;
    
    // IMPORTANT: Get current data BEFORE adding callback to avoid race condition
    // where a trade arrives after callback is added but before snapshot is sent
    let currentData = null;
    switch (channel) {
      case 'tickers': currentData = this.getTicker(exchange, symbol); break;
      case 'orderbook': currentData = this.getOrderbook(exchange, symbol); break;
      case 'trades': currentData = this.getTrades(exchange, symbol); break;
      case 'klines':
        const [sym, interval] = symbol.split(':');
        currentData = this.getKlines(exchange, sym, interval);
        break;
      case 'liquidations': currentData = this.getLiquidations(exchange, symbol); break;
    }
    
    // Now add callback to subscribers
    if (!this.subscribers.has(subKey)) {
      this.subscribers.set(subKey, new Set());
    }
    this.subscribers.get(subKey).add(callback);
    
    // Send snapshot after callback is registered (data was captured before registration)
    if (currentData && (Array.isArray(currentData) ? currentData.length > 0 : true)) {
      callback({ type: 'snapshot', exchange, channel, symbol, data: currentData });
    }

    return () => this.unsubscribe(channel, exchange, symbol, callback);
  }

  unsubscribe(channel, exchange, symbol, callback) {
    const subKey = `${channel}:${exchange}:${symbol}`;
    const subs = this.subscribers.get(subKey);
    if (subs) {
      subs.delete(callback);
      if (subs.size === 0) this.subscribers.delete(subKey);
    }
  }

  notify(channel, exchange, symbol, data) {
    const subKey = `${channel}:${exchange}:${symbol}`;
    const subs = this.subscribers.get(subKey);
    if (subs) {
      const msg = { type: 'update', exchange, channel, symbol, data };
      for (const cb of subs) {
        try {
          cb(msg);
        } catch (e) {
          // Ignore subscriber errors
        }
      }
    }
  }

  // ============= UTILITIES =============

  isStale(key) {
    const lastUpdated = this.lastUpdate.get(key);
    if (!lastUpdated) return true;
    return Date.now() - lastUpdated > this.staleThreshold;
  }

  getStats() {
    const stats = {};
    for (const coll of this._collections) {
      stats[coll] = this[coll].size;
    }
    stats.subscribers = this.subscribers.size;
    return stats;
  }

  getExchangeStats(exchange) {
    const stats = {
      lastInstrumentUpdate: this.lastUpdate.get(`instruments:${exchange}`)
    };
    
    const prefix = exchange + ':';
    for (const coll of ['tickers', 'orderbooks', 'trades', 'instruments']) {
      stats[coll] = Array.from(this[coll].keys()).filter(k => k.startsWith(prefix)).length;
    }
    
    return stats;
  }

  clear(exchange) {
    if (exchange) {
      const prefix = exchange + ':';
      for (const coll of this._collections) {
        const map = this[coll];
        for (const k of map.keys()) {
          if (k.startsWith(prefix)) map.delete(k);
        }
      }
    } else {
      for (const coll of this._collections) {
        this[coll].clear();
      }
      this.lastUpdate.clear();
    }
  }
}

module.exports = StateCache;
