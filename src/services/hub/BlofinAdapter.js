'use strict';

/**
 * Blofin Public WebSocket Adapter
 * Maintains persistent connection to Blofin public streams
 */

const BaseAdapter = require('./BaseAdapter');
const WebSocket = require('ws');

const WS_URL = 'wss://openapi.blofin.com/ws/public';
const REST_URL = 'https://openapi.blofin.com';

class BlofinAdapter extends BaseAdapter {
  constructor(options = {}) {
    super('blofin', WS_URL, options);
  }

  async fetchSymbols() {
    try {
      const res = await this.fetchWithTimeout(`${REST_URL}/api/v1/market/instruments?instType=SWAP`);
      const data = await res.json();
      if (data.code === '0' && data.data) {
        this.symbols = data.data
          .filter(i => i.state === 'live' && i.settleCurrency === 'USDT')
          .map(i => i.instId);
        this.log(`Fetched ${this.symbols.length} symbols`);
      }
    } catch (e) {
      console.error('[BlofinAdapter] Failed to fetch symbols:', e.message);
    }
  }

  // Override startPing for Blofin's string-based ping
  startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send('ping');
      }
    }, this.pingInterval);
  }

  handleMessage(msg) {
    const { arg, data } = msg;
    if (!arg || !data) return;
    
    const channel = arg.channel;
    const symbol = arg.instId;
    const d = Array.isArray(data) ? data[0] : data;

    if (!this.onDataCallback) return;

    if (channel === 'tickers') {
      this.onDataCallback({
        exchange: 'blofin',
        channel: 'tickers',
        symbol,
        data: {
          lastPrice: parseFloat(d.last || 0),
          markPrice: parseFloat(d.markPrice || 0),
          indexPrice: parseFloat(d.indexPrice || 0),
          volume24h: parseFloat(d.vol24h || 0),
          price24hPcnt: parseFloat(d.priceChangePercent || 0) / 100,
          fundingRate: parseFloat(d.fundingRate || 0),
          nextFundingTime: d.nextFundingTime,
          bid1Price: parseFloat(d.bidPrice || 0),
          ask1Price: parseFloat(d.askPrice || 0),
          openInterest: parseFloat(d.openInterest || 0)
        }
      });
    } else if (channel === 'books' || channel === 'books5' || channel === 'books50') {
      this.onDataCallback({
        exchange: 'blofin',
        channel: 'orderbook',
        symbol,
        data: {
          bids: (d.bids || []).map(([p, q]) => [parseFloat(p), parseFloat(q)]),
          asks: (d.asks || []).map(([p, q]) => [parseFloat(p), parseFloat(q)]),
          timestamp: d.ts
        }
      });
    } else if (channel === 'trades') {
      const trades = Array.isArray(data) ? data : [data];
      this.onDataCallback({
        exchange: 'blofin',
        channel: 'trades',
        symbol,
        data: trades.map(t => ({
          price: parseFloat(t.price || 0),
          size: parseFloat(t.size || 0),
          side: t.side === 'buy' ? 'buy' : 'sell',
          timestamp: t.ts,
          tradeId: t.tradeId
        }))
      });
    } else if (channel === 'liquidations') {
      this.onDataCallback({
        exchange: 'blofin',
        channel: 'liquidations',
        symbol: d.instId,
        data: {
          price: parseFloat(d.price || 0),
          size: parseFloat(d.size || 0),
          side: d.side,
          timestamp: d.ts
        }
      });
    } else if (channel.startsWith('candle')) {
      const interval = channel.replace('candle', '');
      this.onDataCallback({
        exchange: 'blofin',
        channel: 'klines',
        symbol,
        interval,
        data: {
          t: parseInt(d.ts || d[0] || 0),
          o: parseFloat(d.open || d[1] || 0),
          h: parseFloat(d.high || d[2] || 0),
          l: parseFloat(d.low || d[3] || 0),
          c: parseFloat(d.close || d[4] || 0),
          v: parseFloat(d.vol || d[5] || 0),
          closed: d.confirm === '1' || d.confirm === true
        }
      });
    }
  }

  /**
   * Optimized batch subscription for Blofin
   */
  subscribeHotSymbols(symbols) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    
    this.hotSymbols = symbols;
    const args = [];
    
    for (const sym of symbols) {
      args.push({ channel: 'trades', instId: sym });
      args.push({ channel: 'books50', instId: sym });
      this.activeSubscriptions.add(`trades:${sym}`);
      this.activeSubscriptions.add(`orderbook:${sym}`);
    }

    if (args.length > 0) {
      this.ws.send(JSON.stringify({ op: 'subscribe', args }));
    }

    this.log(`Subscribed to ${symbols.length} hot symbols (${args.length} topics)`);
  }

  subscribeSymbol(symbol, channels = ['tickers', 'orderbook', 'trades']) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const args = [];
    for (const ch of channels) {
      const key = `${ch}:${symbol}`;
      if (this.activeSubscriptions.has(key)) continue;
      
      if (ch === 'tickers') args.push({ channel: 'tickers', instId: symbol });
      if (ch === 'orderbook') args.push({ channel: 'books50', instId: symbol });
      if (ch === 'trades') args.push({ channel: 'trades', instId: symbol });
      
      this.activeSubscriptions.add(key);
    }

    if (args.length > 0) {
      this.ws.send(JSON.stringify({ op: 'subscribe', args }));
    }
  }

  unsubscribeSymbol(symbol, channels = ['orderbook', 'trades']) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const args = [];
    for (const ch of channels) {
      const key = `${ch}:${symbol}`;
      if (!this.activeSubscriptions.has(key)) continue;
      
      if (ch === 'tickers') args.push({ channel: 'tickers', instId: symbol });
      if (ch === 'orderbook') args.push({ channel: 'books50', instId: symbol });
      if (ch === 'trades') args.push({ channel: 'trades', instId: symbol });
      
      this.activeSubscriptions.delete(key);
    }

    if (args.length > 0) {
      this.ws.send(JSON.stringify({ op: 'unsubscribe', args }));
    }
  }

  subscribeKline(symbol, interval) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const key = `klines:${symbol}:${interval}`;
    if (this.activeSubscriptions.has(key)) return;
    
    const channelName = `candle${interval}`;
    this.activeSubscriptions.add(key);
    this.ws.send(JSON.stringify({ op: 'subscribe', args: [{ channel: channelName, instId: symbol }] }));
  }

  unsubscribeKline(symbol, interval) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const key = `klines:${symbol}:${interval}`;
    if (!this.activeSubscriptions.has(key)) return;
    
    const channelName = `candle${interval}`;
    this.activeSubscriptions.delete(key);
    this.ws.send(JSON.stringify({ op: 'unsubscribe', args: [{ channel: channelName, instId: symbol }] }));
  }
}

module.exports = BlofinAdapter;
