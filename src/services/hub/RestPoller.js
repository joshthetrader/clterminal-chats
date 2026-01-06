'use strict';

/**
 * REST Poller for Public Data Hub
 * Periodically fetches instruments, funding rates, and open interest
 */

const POLL_INTERVAL = 30 * 1000; // 30 seconds

class RestPoller {
  constructor(cache, options = {}) {
    this.cache = cache;
    this.debug = options.debug || false;
    this.rateLimit = options.rateLimit;
    this.pollInterval = options.pollInterval || POLL_INTERVAL;
    this.timers = {};
    this.running = false;
    this.firstPollComplete = false; // Track if initial poll has finished
  }

  log(...args) {
    if (this.debug) console.log('[RestPoller]', ...args);
  }

  /**
   * Centralized JSON fetcher with rate-limit coordination and error handling
   * @private
   */
  async _fetchJSON(exchange, url, options = {}) {
    if (this.rateLimit) this.rateLimit.recordRequest(exchange);
    
    try {
      const res = await fetch(url, options);
      
      if (res.status === 429) {
        if (this.rateLimit) this.rateLimit.reportRateLimit(exchange);
        return null;
      }
      
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }
      
      return await res.json();
    } catch (e) {
      this.log(`${exchange} fetch error:`, e.message);
      throw e;
    }
  }

  async start() {
    if (this.running) return false;
    this.running = true;

    this.log('Started polling every', this.pollInterval / 1000, 'seconds');

    // BLOCKING initial poll - wait for cache to be populated before accepting requests
    const startTime = Date.now();
    try {
      await this.pollAll(true); // Pass true to skip jitter on first poll
      this.firstPollComplete = true;
      console.log(`[RestPoller] ✅ Initial poll complete in ${Date.now() - startTime}ms - cache is warm`);
    } catch (e) {
      console.error('[RestPoller] Initial poll error:', e.message);
      this.firstPollComplete = true; // Mark complete anyway so we don't block forever
    }

    // Start periodic polling AFTER initial poll completes
    this.timers.main = setInterval(() => this.pollAll(false), this.pollInterval);
    
    return this.firstPollComplete;
  }

  stop() {
    this.running = false;
    for (const timer of Object.values(this.timers)) {
      clearInterval(timer);
    }
    this.timers = {};
    this.log('Stopped');
  }

  async pollAll(skipJitter = false) {
    // Add small random jitter (0-2s) to prevent synchronized spikes
    // Skip jitter on first poll for fast startup
    if (!skipJitter) {
      const jitter = Math.floor(Math.random() * 2000);
      if (jitter > 0) {
        await new Promise(resolve => setTimeout(resolve, jitter));
      }
    }

    const exchanges = ['bybit', 'blofin', 'bitunix', 'hyperliquid'];
    const results = await Promise.allSettled(exchanges.map(async (ex) => {
      // Check rate limit if coordinator is available
      if (this.rateLimit && !this.rateLimit.canRequest(ex)) {
        this.log(`Skipping ${ex} poll due to rate limit/backoff`);
        return;
      }

      try {
        if (ex === 'bybit') await this.pollBybit();
        if (ex === 'blofin') await this.pollBlofin();
        if (ex === 'bitunix') await this.pollBitunix();
        if (ex === 'hyperliquid') await this.pollHyperliquid();
      } catch (e) {
        // Errors are already logged in _fetchJSON or individual pollers
        throw e;
      }
    }));

    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        console.error(`[RestPoller] ${exchanges[i]} poll failed:`, r.reason?.message);
      }
    });
  }

  // ============= BYBIT =============

  async pollBybit() {
    try {
      // Instruments
      const instData = await this._fetchJSON('bybit', 'https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000');
      if (instData?.retCode === 0 && instData.result?.list) {
        const instruments = instData.result.list.map(i => ({
          symbol: i.symbol,
          baseCoin: i.baseCoin,
          quoteCoin: i.quoteCoin,
          status: i.status,
          tickSize: parseFloat(i.priceFilter?.tickSize || 0),
          lotSize: parseFloat(i.lotSizeFilter?.qtyStep || 0),
          minOrderQty: parseFloat(i.lotSizeFilter?.minOrderQty || 0),
          maxOrderQty: parseFloat(i.lotSizeFilter?.maxOrderQty || 0),
          minLeverage: parseFloat(i.leverageFilter?.minLeverage || 1),
          maxLeverage: parseFloat(i.leverageFilter?.maxLeverage || 1)
          // raw field removed to save memory
        }));
        this.cache.setInstruments('bybit', instruments);
      }

      // Fetch all tickers which include funding, OI, and volume
      const tickerData = await this._fetchJSON('bybit', 'https://api.bybit.com/v5/market/tickers?category=linear');
      if (tickerData?.retCode === 0 && tickerData.result?.list) {
        for (const t of tickerData.result.list) {
          this.cache.setTicker('bybit', t.symbol, {
            lastPrice: parseFloat(t.lastPrice || 0),
            volume24h: parseFloat(t.volume24h || 0),
            turnover24h: parseFloat(t.turnover24h || 0),
            price24hPcnt: parseFloat(t.price24hPcnt || 0),
            high24h: parseFloat(t.highPrice24h || 0),
            low24h: parseFloat(t.lowPrice24h || 0)
          });
          this.cache.setFunding('bybit', t.symbol, {
            fundingRate: parseFloat(t.fundingRate || 0),
            nextFundingTime: t.nextFundingTime
          });
          this.cache.setOpenInterest('bybit', t.symbol, {
            openInterest: parseFloat(t.openInterest || 0),
            openInterestValue: parseFloat(t.openInterestValue || 0)
          });
        }
      }
      this.log('Bybit poll complete');
    } catch (e) {
      throw new Error(`Bybit: ${e.message}`);
    }
  }

  // ============= BLOFIN =============

  async pollBlofin() {
    try {
      const instData = await this._fetchJSON('blofin', 'https://openapi.blofin.com/api/v1/market/instruments?instType=SWAP');
      const instMap = new Map();
      
      if (instData?.code === '0' && instData.data) {
        const instruments = instData.data.map(i => ({
          symbol: i.instId,
          instId: i.instId,
          baseCcy: i.baseCurrency,
          quoteCcy: i.quoteCurrency,
          settleCurrency: i.settleCurrency,
          tickSize: parseFloat(i.tickSize || 0),
          lotSize: parseFloat(i.lotSize || 0),
          minSize: parseFloat(i.minSize || 0),
          maxSize: parseFloat(i.maxSize || 0),
          maxLeverage: parseFloat(i.maxLeverage || 1),
          contractValue: parseFloat(i.contractValue || 1),
          state: i.state
          // raw field removed to save memory
        }));
        this.cache.setInstruments('blofin', instruments);
        for (const inst of instruments) instMap.set(inst.instId, inst);
      }

      // Funding rates
      const fundingData = await this._fetchJSON('blofin', 'https://openapi.blofin.com/api/v1/market/funding-rate');
      if (fundingData?.code === '0' && fundingData.data) {
        for (const f of fundingData.data) {
          this.cache.setFunding('blofin', f.instId, {
            fundingRate: parseFloat(f.fundingRate || 0),
            nextFundingTime: f.nextFundingTime,
            fundingTime: f.fundingTime
          });
        }
      }

      // Tickers for OI and volume
      const tickerData = await this._fetchJSON('blofin', 'https://openapi.blofin.com/api/v1/market/tickers');
      if (tickerData?.code === '0' && tickerData.data) {
        for (const t of tickerData.data) {
          const price = parseFloat(t.last || 0);
          const contracts = parseFloat(t.vol24h || 0);
          const inst = instMap.get(t.instId);
          const contractValue = inst ? parseFloat(inst.contractValue || 1) : 1;
          const usdVolume = contracts * contractValue * price;
          
          this.cache.setOpenInterest('blofin', t.instId, { openInterest: parseFloat(t.openInterest || 0) });
          
          if (contracts > 0) {
            this.cache.setTicker('blofin', t.instId, {
              lastPrice: price,
              volume24h: contracts,
              turnover24h: usdVolume,
              contractValue: contractValue
            });
          }
        }
      }
      this.log('Blofin poll complete');
    } catch (e) {
      throw new Error(`Blofin: ${e.message}`);
    }
  }

  // ============= BITUNIX =============

  async pollBitunix() {
    try {
      const tickerData = await this._fetchJSON('bitunix', 'https://fapi.bitunix.com/api/v1/futures/market/tickers');
      if (tickerData?.code === 0 && tickerData.data) {
        const instruments = tickerData.data.map(t => ({
          symbol: t.symbol,
          tickSize: parseFloat(t.priceStep || 0),
          lotSize: parseFloat(t.sizeStep || 0),
          minOrderQty: parseFloat(t.minSize || 0)
          // raw field removed to save memory
        }));
        this.cache.setInstruments('bitunix', instruments);

        for (const t of tickerData.data) {
          const price = parseFloat(t.lastPrice || 0);
          const volume = parseFloat(t.quoteVol || 0);
          const open = parseFloat(t.open || 0);
          const change = open > 0 ? ((price - open) / open) : 0;
          
          this.cache.setFunding('bitunix', t.symbol, { fundingRate: parseFloat(t.fundingRate || 0), nextFundingTime: t.nextFundingTime });
          if (t.openInterest) this.cache.setOpenInterest('bitunix', t.symbol, { openInterest: parseFloat(t.openInterest || 0) });
          
          if (price > 0) {
            this.cache.setTicker('bitunix', t.symbol, {
              lastPrice: price,
              volume24h: parseFloat(t.baseVol || 0),
              turnover24h: volume,
              price24hPcnt: change,
              high24h: parseFloat(t.high || 0),
              low24h: parseFloat(t.low || 0)
            });
          }
        }
      }
      this.log('Bitunix poll complete');
    } catch (e) {
      throw new Error(`Bitunix: ${e.message}`);
    }
  }

  // ============= HYPERLIQUID =============

  async pollHyperliquid() {
    try {
      const ctxData = await this._fetchJSON('hyperliquid', 'https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'metaAndAssetCtxs' })
      });
      
      if (!ctxData || !Array.isArray(ctxData) || !ctxData[0]?.universe || !ctxData[1]) {
        throw new Error('Invalid metaAndAssetCtxs response');
      }

      const universe = ctxData[0].universe;
      const assetCtxs = ctxData[1];
      
      const instruments = universe.map((u, idx) => ({
        symbol: u.name,
        name: u.name,
        szDecimals: u.szDecimals,
        maxLeverage: u.maxLeverage,
        assetIndex: idx
        // raw field removed to save memory
      }));
      this.cache.setInstruments('hyperliquid', instruments);
      
      assetCtxs.forEach((ctx, idx) => {
        const name = universe[idx]?.name;
        if (!name) return;

        const markPrice = parseFloat(ctx.markPx || 0);
        const prevDayPx = parseFloat(ctx.prevDayPx || 0);
        const volume24h = parseFloat(ctx.dayNtlVlm || 0);
        const change = prevDayPx > 0 ? ((markPrice - prevDayPx) / prevDayPx) : 0;

        this.cache.setTicker('hyperliquid', name, {
          lastPrice: markPrice,
          markPrice: markPrice,
          prevDayPx: prevDayPx,
          volume24h: volume24h,
          turnover24h: volume24h,
          price24hPcnt: change,
          fundingRate: parseFloat(ctx.funding || 0),
          openInterest: parseFloat(ctx.openInterest || 0)
        });

        this.cache.setFunding('hyperliquid', name, { fundingRate: parseFloat(ctx.funding || 0) });
        this.cache.setOpenInterest('hyperliquid', name, { openInterest: parseFloat(ctx.openInterest || 0) });
      });

      this.log(`Hyperliquid poll complete - ${assetCtxs.length} tickers updated`);
    } catch (e) {
      throw new Error(`Hyperliquid: ${e.message}`);
    }
  }

  async refresh() { await this.pollAll(); }

  getTopSymbolsByVolume(exchange, count = 30) {
    const tickers = this.cache.getTickers(exchange);
    if (!tickers || tickers.length === 0) return [];

    const sorted = tickers
      .filter(t => t && t._symbol && t.turnover24h > 0)
      .sort((a, b) => (b.turnover24h || 0) - (a.turnover24h || 0));

    return sorted.slice(0, count).map(t => t._symbol);
  }

  // ============= KLINE FETCHING (Engineered) =============

  async fetchKlines(exchange, symbol, interval, limit = 200, before = null) {
    const configs = {
      bybit: { 
        url: 'https://api.bybit.com/v5/market/kline', 
        params: { category: 'linear', symbol, interval, limit: Math.min(limit, 200), end: before },
        parser: (d) => d.result?.list?.map(c => ({ t: parseInt(c[0]), o: parseFloat(c[1]), h: parseFloat(c[2]), l: parseFloat(c[3]), c: parseFloat(c[4]), v: parseFloat(c[5]) })).reverse()
      },
      blofin: { 
        url: 'https://openapi.blofin.com/api/v1/market/candles', 
        params: { instId: symbol, bar: interval, limit: Math.min(limit, 100), after: before },
        parser: (d) => d.data?.map(c => ({ t: parseInt(c[0]), o: parseFloat(c[1]), h: parseFloat(c[2]), l: parseFloat(c[3]), c: parseFloat(c[4]), v: parseFloat(c[5]) })).reverse()
      },
      bitunix: { 
        url: 'https://fapi.bitunix.com/api/v1/futures/market/kline', 
        params: { 
          symbol, 
          interval: {
            // Note: 3m is NOT supported by Bitunix API per docs
            '1min': '1m', '5min': '5m', '15min': '15m', '30min': '30m',
            '60min': '1h', '2h': '2h', '4h': '4h', '6h': '6h', '12h': '12h',
            '1day': '1d', '3d': '3d', '1week': '1w', '1month': '1M'
          }[interval] || interval,
          limit: Math.min(limit, 200), 
          endTime: before 
        },
        // Bitunix API returns: time, open, high, low, close, baseVol, quoteVol
        // Data comes newest-first, need .reverse() for chronological order
        parser: (d) => d.data?.map(c => ({ 
          t: parseInt(c.time || c.t), 
          o: parseFloat(c.open || c.o), 
          h: parseFloat(c.high || c.h), 
          l: parseFloat(c.low || c.l), 
          c: parseFloat(c.close || c.c), 
          v: parseFloat(c.baseVol || c.quoteVol || c.v || 0) 
        })).reverse()
      }
    };

    if (exchange === 'hyperliquid') return this.fetchHyperliquidKlines(symbol, interval, limit, before);
    
    const cfg = configs[exchange];
    if (!cfg) return [];

    const query = new URLSearchParams(Object.fromEntries(Object.entries(cfg.params).filter(([_, v]) => v != null)));
    const data = await this._fetchJSON(exchange, `${cfg.url}?${query}`);
    const candles = cfg.parser(data) || [];

    if (candles.length > 0) {
      const existing = this.cache.getKlines(exchange, symbol, interval);
      const combined = [...existing, ...candles]
        .filter((c, idx, arr) => arr.findIndex(x => x.t === c.t) === idx)
        .sort((a, b) => a.t - b.t)
        .slice(-500);
      this.cache.setKlines(exchange, symbol, interval, combined);
    }
    
    return candles;
  }

  async fetchHyperliquidKlines(symbol, interval, limit, before) {
    const coin = symbol.replace(/USDT$|USDC$/i, '');
    const endTime = before || Date.now();
    const startTime = endTime - (limit * this.getIntervalMs(interval));
    
    const data = await this._fetchJSON('hyperliquid', 'https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'candleSnapshot', req: { coin, interval, startTime, endTime } })
    });
    
    if (!Array.isArray(data)) return [];
    
    const candles = data.map(c => ({
      t: parseInt(c.t || c.T), o: parseFloat(c.o), h: parseFloat(c.h), l: parseFloat(c.l), c: parseFloat(c.c), v: parseFloat(c.v || 0)
    })).sort((a, b) => a.t - b.t);

    if (candles.length > 0) {
      const existing = this.cache.getKlines('hyperliquid', symbol, interval);
      const combined = [...existing, ...candles]
        .filter((c, idx, arr) => arr.findIndex(x => x.t === c.t) === idx)
        .sort((a, b) => a.t - b.t)
        .slice(-500);
      this.cache.setKlines('hyperliquid', symbol, interval, combined);
    }
    return candles;
  }

  getIntervalMs(interval) {
    const map = {
      '1': 60000, '1m': 60000, '3': 180000, '3m': 180000, '5': 300000, '5m': 300000,
      '15': 900000, '15m': 900000, '30': 1800000, '30m': 1800000, '60': 3600000, '1h': 3600000, '1H': 3600000,
      '120': 7200000, '2h': 7200000, '240': 14400000, '4h': 14400000, '4H': 14400000,
      '360': 21600000, '6h': 21600000, '720': 43200000, '12h': 43200000,
      'D': 86400000, '1d': 86400000, '1D': 86400000, '1day': 86400000,
      'W': 604800000, '1w': 604800000, 'M': 2592000000, '1M': 2592000000
    };
    return map[interval] || 60000;
  }
}

module.exports = RestPoller;
