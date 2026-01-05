'use strict';

/**
 * DemandTracker - Manages on-demand WebSocket subscriptions
 * 
 * Tracks reference counts for symbol/channel subscriptions across all clients.
 * Hot symbols (top 30 by volume) are always subscribed.
 * Non-hot symbols are subscribed on-demand and cleaned up after 60s of no usage.
 */

const CLEANUP_DELAY = 60 * 1000; // 60 seconds before unsubscribing unused non-hot symbols

class DemandTracker {
  constructor(options = {}) {
    this.debug = options.debug || false;
    
    // Per-exchange hot symbols (top 30 by volume)
    // Map<exchange, Set<symbol>>
    this.hotSymbols = new Map();
    
    // Active subscriptions with reference counts
    // Map<"exchange:symbol" or "exchange:symbol:interval", { channels: Map<channel, clientCount>, isHot: boolean }>
    this.subscriptions = new Map();
    
    // Cleanup timers for non-hot symbols
    // Map<timerKey, timeout>
    this.cleanupTimers = new Map();
    
    // Reference to adapters (set by PublicDataHub)
    this.adapters = {};
  }

  log(...args) {
    if (this.debug) console.log('[DemandTracker]', ...args);
  }

  /**
   * Set the adapters reference for calling subscribe/unsubscribe
   */
  setAdapters(adapters) {
    this.adapters = adapters;
  }

  /**
   * Set hot symbols for an exchange (called after REST poller gets volume data)
   * @param {string} exchange 
   * @param {string[]} symbols - Top 30 symbols by volume
   */
  setHotSymbols(exchange, symbols) {
    this.hotSymbols.set(exchange, new Set(symbols));
    this.log(`Set ${symbols.length} hot symbols for ${exchange}:`, symbols.slice(0, 5).join(', ') + '...');
    
    // Subscribe to hot symbols for trades and orderbook
    const adapter = this.adapters[exchange];
    if (adapter && adapter.subscribeHotSymbols) {
      adapter.subscribeHotSymbols(symbols);
    }
    
    // Mark existing subscriptions as hot if they match
    for (const sym of symbols) {
      const key = `${exchange}:${sym}`;
      const sub = this.subscriptions.get(key);
      if (sub) {
        sub.isHot = true;
      }
    }
  }

  /**
   * Get hot symbols for an exchange
   */
  getHotSymbols(exchange) {
    return this.hotSymbols.get(exchange) || new Set();
  }

  /**
   * Check if a symbol is hot for an exchange
   */
  isHot(exchange, symbol) {
    const hotSet = this.hotSymbols.get(exchange);
    return hotSet ? hotSet.has(symbol) : false;
  }

  /**
   * Internal generic subscription handler
   */
  _handleSubscribe(exchange, symbol, channel, adapterMethod, interval = null) {
    const key = interval ? `${exchange}:${symbol}:${interval}` : `${exchange}:${symbol}`;
    const timerKey = `${key}:${channel}`;
    
    // Cancel any pending cleanup timer
    if (this.cleanupTimers.has(timerKey)) {
      clearTimeout(this.cleanupTimers.get(timerKey));
      this.cleanupTimers.delete(timerKey);
      this.log(`Cancelled cleanup timer for ${timerKey}`);
    }
    
    // Get or create subscription entry
    let sub = this.subscriptions.get(key);
    if (!sub) {
      sub = {
        exchange,
        symbol,
        interval,
        channels: new Map(),
        isHot: this.isHot(exchange, symbol)
      };
      this.subscriptions.set(key, sub);
    }
    
    // Get current count for this channel
    const currentCount = sub.channels.get(channel) || 0;
    const isNewSubscription = currentCount === 0;
    
    // Increment count
    sub.channels.set(channel, currentCount + 1);
    
    // If first subscriber for this channel, tell adapter to subscribe
    if (isNewSubscription) {
      const adapter = this.adapters[exchange];
      if (adapter && adapter[adapterMethod]) {
        this.log(`First subscriber for ${exchange}/${symbol}/${channel}${interval ? ':' + interval : ''} - subscribing`);
        if (interval) {
          adapter[adapterMethod](symbol, interval);
        } else if (adapterMethod === 'subscribeSymbol') {
          adapter[adapterMethod](symbol, [channel]);
        } else {
          adapter[adapterMethod](symbol);
        }
      }
      return true;
    }
    
    this.log(`Added subscriber for ${exchange}/${symbol}/${channel}${interval ? ':' + interval : ''} (count: ${currentCount + 1})`);
    return false;
  }

  /**
   * Internal generic unsubscription handler
   */
  _handleUnsubscribe(exchange, symbol, channel, performCleanupMethod, interval = null) {
    const key = interval ? `${exchange}:${symbol}:${interval}` : `${exchange}:${symbol}`;
    const timerKey = `${key}:${channel}`;
    
    const sub = this.subscriptions.get(key);
    if (!sub) return;
    
    const currentCount = sub.channels.get(channel) || 0;
    if (currentCount <= 0) return;
    
    const newCount = currentCount - 1;
    sub.channels.set(channel, newCount);
    
    this.log(`Removed subscriber for ${exchange}/${symbol}/${channel}${interval ? ':' + interval : ''} (count: ${newCount})`);
    
    // If no more subscribers for this channel
    if (newCount === 0) {
      // Hot symbols never unsubscribe (except for klines which are never hot)
      if (sub.isHot && channel !== 'klines') {
        this.log(`${exchange}/${symbol} is hot - keeping subscribed`);
        return;
      }
      
      // Schedule cleanup for non-hot symbols
      this.log(`Scheduling cleanup for ${timerKey} in ${CLEANUP_DELAY / 1000}s`);
      
      const timer = setTimeout(() => {
        this.cleanupTimers.delete(timerKey);
        this[performCleanupMethod](exchange, symbol, channel, interval);
      }, CLEANUP_DELAY);
      
      this.cleanupTimers.set(timerKey, timer);
    }
  }

  /**
   * Internal generic cleanup performer
   */
  _performCleanup(exchange, symbol, channel, adapterMethod, interval = null) {
    const key = interval ? `${exchange}:${symbol}:${interval}` : `${exchange}:${symbol}`;
    const sub = this.subscriptions.get(key);
    
    if (!sub) return;
    
    // Double-check count is still 0
    const count = sub.channels.get(channel) || 0;
    if (count > 0) {
      this.log(`Cleanup cancelled for ${exchange}/${symbol}/${channel}${interval ? ':' + interval : ''} - has ${count} subscribers`);
      return;
    }
    
    // Remove channel from subscription
    sub.channels.delete(channel);
    
    // Tell adapter to unsubscribe
    const adapter = this.adapters[exchange];
    if (adapter && adapter[adapterMethod]) {
      this.log(`Cleaning up ${exchange}/${symbol}/${channel}${interval ? ':' + interval : ''}`);
      if (interval) {
        adapter[adapterMethod](symbol, interval);
      } else if (adapterMethod === 'unsubscribeSymbol') {
        adapter[adapterMethod](symbol, [channel]);
      } else {
        adapter[adapterMethod](symbol);
      }
    }
    
    // If no more channels for this symbol, remove the subscription entry
    if (sub.channels.size === 0) {
      this.subscriptions.delete(key);
    }
  }

  // ============= PUBLIC METHODS =============

  subscribe(exchange, symbol, channel) {
    return this._handleSubscribe(exchange, symbol, channel, 'subscribeSymbol');
  }

  unsubscribe(exchange, symbol, channel) {
    this._handleUnsubscribe(exchange, symbol, channel, 'performCleanup');
  }

  performCleanup(exchange, symbol, channel) {
    this._performCleanup(exchange, symbol, channel, 'unsubscribeSymbol');
  }

  subscribeKline(exchange, symbol, interval) {
    return this._handleSubscribe(exchange, symbol, 'klines', 'subscribeKline', interval);
  }

  unsubscribeKline(exchange, symbol, interval) {
    this._handleUnsubscribe(exchange, symbol, 'klines', 'performKlineCleanup', interval);
  }

  performKlineCleanup(exchange, symbol, interval) {
    this._performCleanup(exchange, symbol, 'klines', 'unsubscribeKline', interval);
  }

  subscribeLiquidation(exchange, symbol) {
    if (exchange !== 'bybit') {
      this.log(`Liquidations only available on Bybit, not ${exchange}`);
      return false;
    }
    return this._handleSubscribe(exchange, symbol, 'liquidations', 'subscribeLiquidation');
  }

  unsubscribeLiquidation(exchange, symbol) {
    if (exchange !== 'bybit') return;
    this._handleUnsubscribe(exchange, symbol, 'liquidations', 'performLiquidationCleanup');
  }

  performLiquidationCleanup(exchange, symbol) {
    this._performCleanup(exchange, symbol, 'liquidations', 'unsubscribeLiquidation');
  }

  /**
   * Check if a symbol/channel is currently subscribed
   */
  isSubscribed(exchange, symbol, channel) {
    const key = (channel === 'klines' && symbol.includes(':')) ? 
      `${exchange}:${symbol}` : `${exchange}:${symbol}`;
    // Klines in isSubscribed are handled a bit differently depending on caller
    // but the most common check is via key
    const sub = this.subscriptions.get(key);
    if (!sub) return false;
    return (sub.channels.get(channel) || 0) > 0;
  }

  /**
   * Get subscription stats for debugging/health
   */
  getStats() {
    const stats = {
      totalSubscriptions: this.subscriptions.size,
      pendingCleanups: this.cleanupTimers.size,
      perExchange: {}
    };
    
    for (const sub of this.subscriptions.values()) {
      const exchange = sub.exchange;
      if (!stats.perExchange[exchange]) {
        stats.perExchange[exchange] = { symbols: 0, channels: 0 };
      }
      stats.perExchange[exchange].symbols++;
      stats.perExchange[exchange].channels += sub.channels.size;
    }
    
    return stats;
  }

  /**
   * Clean up all timers on shutdown
   */
  destroy() {
    for (const timer of this.cleanupTimers.values()) {
      clearTimeout(timer);
    }
    this.cleanupTimers.clear();
    this.subscriptions.clear();
    this.hotSymbols.clear();
  }
}

module.exports = DemandTracker;
