'use strict';

/**
 * RequestDeduplicator - Merges identical in-flight REST requests
 * Prevents multiple clients from triggering the same exchange API call simultaneously.
 */

class RequestDeduplicator {
  constructor(options = {}) {
    this.debug = options.debug || false;
    this.pending = new Map(); // key -> Promise
  }

  log(...args) {
    if (this.debug) console.log('[RequestDeduplicator]', ...args);
  }

  /**
   * Execute a request or join an existing one
   * @param {string} key - Unique key for the request (e.g. "bybit:klines:BTCUSDT:1m")
   * @param {Function} fetchFn - Async function that performs the actual fetch
   * @returns {Promise<any>}
   */
  async execute(key, fetchFn) {
    // If request already in flight, return the existing promise
    if (this.pending.has(key)) {
      this.log(`Joining existing request for ${key}`);
      return this.pending.get(key);
    }

    // Start new request
    this.log(`Starting new request for ${key}`);
    const promise = (async () => {
      try {
        return await fetchFn();
      } finally {
        // Always remove from pending regardless of success/failure
        this.pending.delete(key);
      }
    })();

    this.pending.set(key, promise);
    return promise;
  }

  /**
   * Clear all pending requests (for shutdown)
   */
  clear() {
    this.pending.clear();
  }

  getStats() {
    return {
      pendingRequests: this.pending.size,
      keys: Array.from(this.pending.keys())
    };
  }
}

module.exports = RequestDeduplicator;


