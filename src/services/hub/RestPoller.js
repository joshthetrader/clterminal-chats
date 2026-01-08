'use strict';

/**
 * REST Poller for Public Data Hub
 * Periodically fetches instruments, funding rates, and open interest
 */

// ============= CONSTANTS =============
const POLL_INTERVAL = 30 * 1000;
const FETCH_TIMEOUT = 10000;
const KLINE_CACHE_LIMIT = 500;
const DEFAULT_KLINE_LIMIT = 200;
const MAX_JITTER_MS = 2000;

const BITUNIX_INTERVAL_MAP = {
  '1min': '1m', '5min': '5m', '15min': '15m', '30min': '30m',
  '60min': '1h', '2h': '2h', '4h': '4h', '6h': '6h', '12h': '12h',
  '1day': '1d', '3d': '3d', '1week': '1w', '1month': '1M'
};

const INTERVAL_MS_MAP = {
  '1': 60000, '1m': 60000, '3': 180000, '3m': 180000, '5': 300000, '5m': 300000,
  '15': 900000, '15m': 900000, '30': 1800000, '30m': 1800000,
  '60': 3600000, '1h': 3600000, '1H': 3600000,
  '120': 7200000, '2h': 7200000, '240': 14400000, '4h': 14400000, '4H': 14400000,
  '360': 21600000, '6h': 21600000, '720': 43200000, '12h': 43200000,
  'D': 86400000, '1d': 86400000, '1D': 86400000, '1day': 86400000,
  'W': 604800000, '1w': 604800000, 'M': 2592000000, '1M': 2592000000
};

class RestPoller {
  constructor(cache, options = {}) {
    this.cache = cache;
    this.debug = options.debug || false;
    this.rateLimit = options.rateLimit;
    this.pollInterval = options.pollInterval || POLL_INTERVAL;
    this.timers = {};
    this.running = false;
    this.firstPollComplete = false;
  }

  log(...args) {
    if (this.debug) console.log('[RestPoller]', ...args);
  }

  /**
   * Centralized JSON fetcher with timeout, rate-limit coordination, and error handling
   */
  async _fetchJSON(exchange, url, options = {}) {
    if (this.rateLimit) this.rateLimit.recordRequest(exchange);
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      
      if (res.status === 429) {
        if (this.rateLimit) this.rateLimit.reportRateLimit(exchange);
        return null;
      }
      
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      
      return await res.json();
    } catch (e) {
      if (e.name === 'AbortError') throw new Error(`${exchange} request timeout`);
      this.log(`${exchange} fetch error:`, e.message);
      throw e;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Merge new klines with existing cache using O(n) deduplication
   */
  _mergeAndCacheKlines(exchange, symbol, interval, newCandles) {
    if (!newCandles?.length) return;
    
    const existing = this.cache.getKlines(exchange, symbol, interval) || [];
    const seen = new Set();
    const combined = [...existing, ...newCandles]
      .filter(c => c && !seen.has(c.t) && seen.add(c.t))
      .sort((a, b) => a.t - b.t)
      .slice(-KLINE_CACHE_LIMIT);
    
    this.cache.setKlines(exchange, symbol, interval, combined);
  }

  async start() {
    if (this.running) return false;
    this.running = true;

    this.log('Started polling every', this.pollInterval / 1000, 'seconds');

    const startTime = Date.now();
    try {
      await this.pollAll(true);
      this.firstPollComplete = true;
      console.log(`[RestPoller] ✅ Initial poll complete in ${Date.now() - startTime}ms - cache is warm`);
    } catch (e) {
      console.error('[RestPoller] Initial poll error:', e.message);
      this.firstPollComplete = true;
    }

    this.timers.main = setInterval(() => this.pollAll(false), this.pollInterval);
    return this.firstPollComplete;
  }

  stop() {
    this.running = false;
    Object.values(this.timers).forEach(clearInterval);
    this.timers = {};
    this.log('Stopped');
  }

  async pollAll(skipJitter = false) {
    if (!skipJitter) {
      const jitter = Math.floor(Math.random() * MAX_JITTER_MS);
      if (jitter > 0) await new Promise(r => setTimeout(r, jitter));
    }

    const exchanges = ['bybit', 'blofin', 'bitunix', 'hyperliquid'];
    const results = await Promise.allSettled(exchanges.map(ex => this.pollExchange(ex)));

    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        console.error(`[RestPoller] ${exchanges[i]} poll failed:`, r.reason?.message);
      }
    });
  }

  async pollExchange(exchange) {
    if (this.rateLimit && !this.rateLimit.canRequest(exchange)) {
      this.log(`Skipping ${exchange} poll due to rate limit/backoff`);
      return;
    }

    const pollers = {
      bybit: () => this.pollBybit(),
      blofin: () => this.pollBlofin(),
      bitunix: () => this.pollBitunix(),
      hyperliquid: () => this.pollHyperliquid()
    };
    
    return pollers[exchange]?.();
  }

  // ============= BYBIT =============

  async pollBybit() {
    try {
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
        }));
        this.cache.setInstruments('bybit', instruments);
      }

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
        }));
        this.cache.setInstruments('blofin', instruments);
        instruments.forEach(inst => instMap.set(inst.instId, inst));
      }

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

      const tickerData = await this._fetchJSON('blofin', 'https://openapi.blofin.com/api/v1/market/tickers');
      if (tickerData?.code === '0' && tickerData.data) {
        for (const t of tickerData.data) {
          const price = parseFloat(t.last || 0);
          const contracts = parseFloat(t.vol24h || 0);
          const inst = instMap.get(t.instId);
          const contractValue = inst?.contractValue || 1;
          const usdVolume = contracts * contractValue * price;
          
          this.cache.setOpenInterest('blofin', t.instId, { openInterest: parseFloat(t.openInterest || 0) });
          
          if (contracts > 0) {
            this.cache.setTicker('blofin', t.instId, {
              lastPrice: price,
              volume24h: contracts,
              turnover24h: usdVolume,
              contractValue
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
      const [pairsData, tickerData] = await Promise.all([
        this._fetchJSON('bitunix', 'https://fapi.bitunix.com/api/v1/futures/market/trading_pairs'),
        this._fetchJSON('bitunix', 'https://fapi.bitunix.com/api/v1/futures/market/tickers')
      ]);
      
      const validSymbols = new Set();
      if (pairsData?.code === 0 && pairsData.data) {
        pairsData.data.forEach(p => p.symbol && validSymbols.add(p.symbol));
        
        const instruments = pairsData.data.map(t => ({
          symbol: t.symbol,
          tickSize: Math.pow(10, -(t.quotePrecision || 2)),
          lotSize: Math.pow(10, -(t.basePrecision || 4)),
          minOrderQty: parseFloat(t.minTradeVolume || 0)
        }));
        this.cache.setInstruments('bitunix', instruments);
      }
      
      if (tickerData?.code === 0 && tickerData.data) {
        const validTickers = tickerData.data.filter(t => validSymbols.has(t.symbol));
        
        for (const t of validTickers) {
          const price = parseFloat(t.lastPrice || 0);
          const volume = parseFloat(t.quoteVol || 0);
          const open = parseFloat(t.open || 0);
          const change = open > 0 ? (price - open) / open : 0;
          
          this.cache.setFunding('bitunix', t.symbol, { 
            fundingRate: parseFloat(t.fundingRate || 0), 
            nextFundingTime: t.nextFundingTime 
          });
          
          if (t.openInterest) {
            this.cache.setOpenInterest('bitunix', t.symbol, { openInterest: parseFloat(t.openInterest || 0) });
          }
          
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
        this.log(`Bitunix poll complete: ${validTickers.length}/${tickerData.data.length} valid pairs`);
      }
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
      
      // Build index map preserving original indices, then filter
      const validPerps = new Map();
      universe.forEach((u, originalIdx) => {
        if (!u.isDelisted) validPerps.set(u.name, originalIdx);
      });
      
      const instruments = Array.from(validPerps.entries()).map(([name, originalIdx]) => {
        const u = universe[originalIdx];
        return {
          symbol: name,
          name,
          szDecimals: u.szDecimals,
          maxLeverage: u.maxLeverage,
          assetIndex: originalIdx
        };
      });
      this.cache.setInstruments('hyperliquid', instruments);
      
      assetCtxs.forEach((ctx, idx) => {
        const name = universe[idx]?.name;
        if (!name || !validPerps.has(name)) return;

        const markPrice = parseFloat(ctx.markPx || 0);
        const prevDayPx = parseFloat(ctx.prevDayPx || 0);
        const volume24h = parseFloat(ctx.dayNtlVlm || 0);
        const change = prevDayPx > 0 ? (markPrice - prevDayPx) / prevDayPx : 0;

        this.cache.setTicker('hyperliquid', name, {
          lastPrice: markPrice,
          markPrice,
          prevDayPx,
          volume24h,
          turnover24h: volume24h,
          price24hPcnt: change,
          fundingRate: parseFloat(ctx.funding || 0),
          openInterest: parseFloat(ctx.openInterest || 0)
        });

        this.cache.setFunding('hyperliquid', name, { fundingRate: parseFloat(ctx.funding || 0) });
        this.cache.setOpenInterest('hyperliquid', name, { openInterest: parseFloat(ctx.openInterest || 0) });
      });

      this.log(`Hyperliquid poll complete - ${validPerps.size} valid tickers`);
    } catch (e) {
      throw new Error(`Hyperliquid: ${e.message}`);
    }
  }

  async refresh() { await this.pollAll(); }

  getTopSymbolsByVolume(exchange, count = 30) {
    const tickers = this.cache.getTickers(exchange);
    if (!tickers?.length) return [];

    return tickers
      .filter(t => t?._symbol && t.turnover24h > 0)
      .sort((a, b) => (b.turnover24h || 0) - (a.turnover24h || 0))
      .slice(0, count)
      .map(t => t._symbol);
  }

  // ============= KLINE FETCHING =============

  async fetchKlines(exchange, symbol, interval, limit = DEFAULT_KLINE_LIMIT, before = null) {
    if (exchange === 'hyperliquid') {
      return this.fetchHyperliquidKlines(symbol, interval, limit, before);
    }
    
    const configs = {
      bybit: { 
        url: 'https://api.bybit.com/v5/market/kline', 
        params: { category: 'linear', symbol, interval, limit: Math.min(limit, 200), end: before },
        parser: d => d.result?.list?.map(c => ({ 
          t: parseInt(c[0]), o: parseFloat(c[1]), h: parseFloat(c[2]), 
          l: parseFloat(c[3]), c: parseFloat(c[4]), v: parseFloat(c[5]) 
        })).reverse()
      },
      blofin: { 
        url: 'https://openapi.blofin.com/api/v1/market/candles', 
        params: { instId: symbol, bar: interval, limit: Math.min(limit, 100), after: before },
        parser: d => d.data?.map(c => ({ 
          t: parseInt(c[0]), o: parseFloat(c[1]), h: parseFloat(c[2]), 
          l: parseFloat(c[3]), c: parseFloat(c[4]), v: parseFloat(c[5]) 
        })).reverse()
      },
      bitunix: { 
        url: 'https://fapi.bitunix.com/api/v1/futures/market/kline', 
        params: { 
          symbol, 
          interval: BITUNIX_INTERVAL_MAP[interval] || interval,
          limit: Math.min(limit, 200), 
          endTime: before 
        },
        parser: d => d.data?.map(c => ({ 
          t: parseInt(c.time || c.t), 
          o: parseFloat(c.open || c.o), 
          h: parseFloat(c.high || c.h), 
          l: parseFloat(c.low || c.l), 
          c: parseFloat(c.close || c.c), 
          v: parseFloat(c.baseVol || c.quoteVol || c.v || 0) 
        })).reverse()
      }
    };

    const cfg = configs[exchange];
    if (!cfg) return [];

    const query = new URLSearchParams(
      Object.entries(cfg.params).filter(([, v]) => v != null)
    );
    const data = await this._fetchJSON(exchange, `${cfg.url}?${query}`);
    const candles = cfg.parser(data) || [];

    this._mergeAndCacheKlines(exchange, symbol, interval, candles);
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
    
    const candles = data
      .map(c => ({
        t: parseInt(c.t || c.T), 
        o: parseFloat(c.o), 
        h: parseFloat(c.h), 
        l: parseFloat(c.l), 
        c: parseFloat(c.c), 
        v: parseFloat(c.v || 0)
      }))
      .sort((a, b) => a.t - b.t);

    this._mergeAndCacheKlines('hyperliquid', symbol, interval, candles);
    return candles;
  }

  getIntervalMs(interval) {
    return INTERVAL_MS_MAP[interval] || 60000;
  }
}

module.exports = RestPoller;
