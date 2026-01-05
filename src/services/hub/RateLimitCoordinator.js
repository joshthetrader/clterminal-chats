'use strict';

/**
 * RateLimitCoordinator - Tracks and manages rate limits for exchange REST APIs
 * Helps prevent IP bans by coordinating request timing and handling 429 backoffs.
 */

class RateLimitCoordinator {
  constructor(options = {}) {
    this.debug = options.debug || false;
    
    // exchange -> { requestCount, lastReset, backoffUntil }
    this.stats = new Map();
    
    // Default window is 1 minute
    this.windowMs = options.windowMs || 60000;
  }

  log(...args) {
    if (this.debug) console.log('[RateLimitCoordinator]', ...args);
  }

  /**
   * Check if we can make a request to the exchange
   * @param {string} exchange 
   * @returns {boolean} - true if allowed, false if blocked
   */
  canRequest(exchange) {
    const now = Date.now();
    let s = this.stats.get(exchange);
    
    if (!s) {
      s = { requestCount: 0, lastReset: now, backoffUntil: 0 };
      this.stats.set(exchange, s);
      return true;
    }

    // Check backoff
    if (s.backoffUntil > now) {
      this.log(`Blocked ${exchange} - backing off for another ${Math.ceil((s.backoffUntil - now) / 1000)}s`);
      return false;
    }

    // Reset window if needed
    if (now - s.lastReset > this.windowMs) {
      s.requestCount = 0;
      s.lastReset = now;
    }

    return true;
  }

  /**
   * Record a request made to the exchange
   * @param {string} exchange 
   */
  recordRequest(exchange) {
    let s = this.stats.get(exchange);
    if (!s) {
      s = { requestCount: 0, lastReset: Date.now(), backoffUntil: 0 };
      this.stats.set(exchange, s);
    }
    s.requestCount++;
  }

  /**
   * Signal that we've been rate limited (429)
   * @param {string} exchange 
   * @param {number} retryAfterMs - How long to back off (optional, defaults to 30s)
   */
  reportRateLimit(exchange, retryAfterMs = 30000) {
    const now = Date.now();
    const backoffUntil = now + retryAfterMs;
    
    let s = this.stats.get(exchange);
    if (!s) {
      s = { requestCount: 0, lastReset: now, backoffUntil: backoffUntil };
      this.stats.set(exchange, s);
    } else {
      s.backoffUntil = backoffUntil;
    }
    
    console.warn(`[RateLimitCoordinator] ⚠️ ${exchange} RATE LIMITED - Backing off for ${retryAfterMs / 1000}s`);
  }

  /**
   * Get stats for health check
   */
  getStats() {
    const result = {};
    for (const [exchange, s] of this.stats) {
      result[exchange] = {
        ...s,
        isBackingOff: s.backoffUntil > Date.now()
      };
    }
    return result;
  }
}

module.exports = RateLimitCoordinator;


