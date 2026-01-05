'use strict';

/**
 * Bybit Public WebSocket Adapter
 * Maintains persistent connection to Bybit public streams
 */

const BaseAdapter = require('./BaseAdapter');
const WebSocket = require('ws');

const WS_URL = 'wss://stream.bybit.com/v5/public/linear';
const REST_URL = 'https://api.bybit.com';
const MAX_SUBS_PER_MESSAGE = 10;

class BybitAdapter extends BaseAdapter {
  constructor(options = {}) {
    super('bybit', WS_URL, options);
  }

  // Called when WebSocket connects - subscribe to ALL liquidations immediately
  _onOpen() {
    this.subscribeAllLiquidations();
  }

  async fetchSymbols() {
    try {
      const res = await this.fetchWithTimeout(`${REST_URL}/v5/market/instruments-info?category=linear&limit=1000`);
      const data = await res.json();
      if (data.retCode === 0 && data.result?.list) {
        this.symbols = data.result.list
          .filter(i => i.status === 'Trading' && i.quoteCoin === 'USDT')
          .map(i => i.symbol);
        this.log(`Fetched ${this.symbols.length} symbols`);
      }
    } catch (e) {
      console.error('[BybitAdapter] Failed to fetch symbols:', e.message);
    }
  }

  handleMessage(msg) {
    const { topic, data } = msg;
    if (!topic || !data) return;
    
    const parts = topic.split('.');
    const channel = parts[0];
    const symbol = parts[parts.length - 1]; // Symbol is usually the last part

    if (!this.onDataCallback) return;

    if (channel === 'tickers') {
      this.onDataCallback({
        exchange: 'bybit',
        channel: 'tickers',
        symbol,
        data: {
          lastPrice: parseFloat(data.lastPrice || 0),
          markPrice: parseFloat(data.markPrice || 0),
          indexPrice: parseFloat(data.indexPrice || 0),
          volume24h: parseFloat(data.volume24h || 0),
          turnover24h: parseFloat(data.turnover24h || 0),
          price24hPcnt: parseFloat(data.price24hPcnt || 0),
          fundingRate: parseFloat(data.fundingRate || 0),
          nextFundingTime: data.nextFundingTime,
          bid1Price: parseFloat(data.bid1Price || 0),
          ask1Price: parseFloat(data.ask1Price || 0),
          openInterest: parseFloat(data.openInterest || 0)
        }
      });
    } else if (channel === 'orderbook') {
      // orderbook.50.BTCUSDT
      const sym = parts[2];
      this.onDataCallback({
        exchange: 'bybit',
        channel: 'orderbook',
        symbol: sym,
        data: {
          bids: (data.b || []).map(([p, q]) => [parseFloat(p), parseFloat(q)]),
          asks: (data.a || []).map(([p, q]) => [parseFloat(p), parseFloat(q)]),
          updateId: data.u,
          crossSeq: data.seq,
          timestamp: msg.ts
        }
      });
    } else if (channel === 'publicTrade') {
      const trades = Array.isArray(data) ? data : [data];
      this.onDataCallback({
        exchange: 'bybit',
        channel: 'trades',
        symbol,
        data: trades.map(t => ({
          price: parseFloat(t.p || 0),
          size: parseFloat(t.v || 0),
          side: t.S === 'Buy' ? 'buy' : 'sell',
          timestamp: t.T,
          tradeId: t.i
        }))
      });
    } else if (channel === 'allLiquidation') {
      // allLiquidation.BTCUSDT - data is array per Bybit docs
      const liqs = Array.isArray(data) ? data : [data];
      for (const liq of liqs) {
        this.onDataCallback({
          exchange: 'bybit',
          channel: 'liquidations',
          symbol: liq.s, // Symbol from data
          data: {
            id: `${liq.s}-${liq.T}-${liq.v}-${liq.p}`,
            symbol: liq.s,
            price: parseFloat(liq.p || 0),
            size: parseFloat(liq.v || 0),
            side: liq.S, // 'Buy' or 'Sell'
            timestamp: liq.T
          }
        });
      }
    } else if (channel === 'kline') {
      // kline.1.BTCUSDT
      const interval = parts[1];
      const sym = parts[2];
      const candles = Array.isArray(data) ? data : [data];
      for (const c of candles) {
        this.onDataCallback({
          exchange: 'bybit',
          channel: 'klines',
          symbol: sym,
          interval,
          data: {
            t: parseInt(c.start || c.openTime || 0),
            o: parseFloat(c.open || 0),
            h: parseFloat(c.high || 0),
            l: parseFloat(c.low || 0),
            c: parseFloat(c.close || 0),
            v: parseFloat(c.volume || 0),
            closed: c.confirm === true
          }
        });
      }
    }
  }

  subscribeHotSymbols(symbols) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    
    this.hotSymbols = symbols;
    const topics = [];
    
    for (const sym of symbols) {
      topics.push(`publicTrade.${sym}`);
      topics.push(`orderbook.50.${sym}`);
      this.activeSubscriptions.add(`trades:${sym}`);
      this.activeSubscriptions.add(`orderbook:${sym}`);
    }

    for (let i = 0; i < topics.length; i += MAX_SUBS_PER_MESSAGE) {
      const batch = topics.slice(i, i + MAX_SUBS_PER_MESSAGE);
      this.ws.send(JSON.stringify({ op: 'subscribe', args: batch }));
    }

    this.log(`Subscribed to ${symbols.length} hot symbols (${topics.length} topics)`);
  }

  /**
   * Subscribe to allLiquidation for top USDT symbols
   * Limited to top 50 symbols to reduce memory and CPU usage
   */
  subscribeAllLiquidations() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.activeSubscriptions.has('liquidations:ALL')) return;
    
    // Limit to top 50 symbols to reduce subscription overhead and memory usage
    // Most liquidations happen on major symbols anyway
    const syms = this.symbols.length > 0 ? this.symbols.slice(0, 50) : [
      'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT',
      'BNBUSDT', 'ADAUSDT', 'AVAXUSDT', 'DOTUSDT', 'MATICUSDT',
      'LINKUSDT', 'LTCUSDT', 'UNIUSDT', 'ATOMUSDT', 'XLMUSDT',
      'SHIBUSDT', 'TRXUSDT', 'NEARUSDT', 'APTUSDT', 'AAVEUSDT',
      'LDOUSDT', 'INJUSDT', 'OPUSDT', 'ARBUSDT', 'SUIUSDT'
    ];
    
    const topics = syms.map(s => `allLiquidation.${s}`);
    
    // Subscribe in batches
    for (let i = 0; i < topics.length; i += MAX_SUBS_PER_MESSAGE) {
      const batch = topics.slice(i, i + MAX_SUBS_PER_MESSAGE);
      setTimeout(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ op: 'subscribe', args: batch }));
        }
      }, (i / MAX_SUBS_PER_MESSAGE) * 100); // Stagger subscriptions
    }
    
    this.activeSubscriptions.add('liquidations:ALL');
    this.log(`Subscribed to allLiquidation for ${syms.length} symbols`);
  }

  subscribeSymbol(symbol, channels = ['tickers', 'orderbook', 'trades']) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const topics = [];
    for (const ch of channels) {
      const key = `${ch}:${symbol}`;
      if (this.activeSubscriptions.has(key)) continue;
      
      if (ch === 'tickers') topics.push(`tickers.${symbol}`);
      if (ch === 'orderbook') topics.push(`orderbook.50.${symbol}`);
      if (ch === 'trades') topics.push(`publicTrade.${symbol}`);
      
      this.activeSubscriptions.add(key);
    }

    if (topics.length > 0) {
      this.ws.send(JSON.stringify({ op: 'subscribe', args: topics }));
    }
  }

  unsubscribeSymbol(symbol, channels = ['orderbook', 'trades']) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const topics = [];
    for (const ch of channels) {
      const key = `${ch}:${symbol}`;
      if (!this.activeSubscriptions.has(key)) continue;
      
      if (ch === 'tickers') topics.push(`tickers.${symbol}`);
      if (ch === 'orderbook') topics.push(`orderbook.50.${symbol}`);
      if (ch === 'trades') topics.push(`publicTrade.${symbol}`);
      
      this.activeSubscriptions.delete(key);
    }

    if (topics.length > 0) {
      this.ws.send(JSON.stringify({ op: 'unsubscribe', args: topics }));
    }
  }

  subscribeKline(symbol, interval) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const key = `klines:${symbol}:${interval}`;
    if (this.activeSubscriptions.has(key)) return;
    
    const topic = `kline.${interval}.${symbol}`;
    this.activeSubscriptions.add(key);
    this.ws.send(JSON.stringify({ op: 'subscribe', args: [topic] }));
  }

  unsubscribeKline(symbol, interval) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const key = `klines:${symbol}:${interval}`;
    if (!this.activeSubscriptions.has(key)) return;
    
    const topic = `kline.${interval}.${symbol}`;
    this.activeSubscriptions.delete(key);
    this.ws.send(JSON.stringify({ op: 'unsubscribe', args: [topic] }));
  }

  subscribeLiquidation(symbol) {
    // All liquidations are already subscribed via subscribeAllLiquidations()
    // Just mark as active for tracking
    const key = `liquidations:${symbol}`;
    this.activeSubscriptions.add(key);
    
    // Ensure all liquidations are subscribed
    if (!this.activeSubscriptions.has('liquidations:ALL')) {
      this.subscribeAllLiquidations();
    }
  }

  unsubscribeLiquidation(symbol) {
    // We don't actually unsubscribe from the feed - it's shared
    // Just remove from tracking
    const key = `liquidations:${symbol}`;
    this.activeSubscriptions.delete(key);
  }
}

module.exports = BybitAdapter;
