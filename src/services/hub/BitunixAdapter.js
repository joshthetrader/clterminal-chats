'use strict';

/**
 * Bitunix Public WebSocket Adapter
 * Maintains persistent connection to Bitunix public streams
 * NOTE: Bitunix has 300 subscription limit per connection
 */

const BaseAdapter = require('./BaseAdapter');
const WebSocket = require('ws');

const WS_URL = 'wss://fapi.bitunix.com/public/';
const REST_URL = 'https://fapi.bitunix.com';
const SUB_LIMIT = 300;

class BitunixAdapter extends BaseAdapter {
  constructor(options = {}) {
    super('bitunix', WS_URL, options);
    this.subscriptionCount = 0;
  }

  async fetchSymbols() {
    try {
      const res = await this.fetchWithTimeout(`${REST_URL}/api/v1/futures/market/tickers`);
      const data = await res.json();
      if (data.code === 0 && data.data) {
        this.symbols = data.data
          .filter(i => {
            const sym = i.symbol || '';
            return sym.match(/USD[TCA]?$|CUSD$|XUSD$|EUSD$|HUSD$|MUSD$|BUSD$|KUSD$|AUSD$/);
          })
          .map(i => i.symbol);
        this.log(`Fetched ${this.symbols.length} symbols`);
      }
    } catch (e) {
      console.error('[BitunixAdapter] Failed to fetch symbols:', e.message);
    }
  }

  // Override _onOpen to reset sub count
  _onOpen() {
    this.subscriptionCount = 0;
    super._onOpen();
  }

  handleMessage(msg) {
    const { ch, symbol, data } = msg;
    if (!ch || !data) return;

    if (!this.onDataCallback) return;

    if (ch === 'ticker') {
      this.onDataCallback({
        exchange: 'bitunix',
        channel: 'tickers',
        symbol,
        data: {
          lastPrice: parseFloat(data.la || data.lp || 0),
          markPrice: parseFloat(data.mp || 0),
          indexPrice: parseFloat(data.ip || 0),
          volume24h: parseFloat(data.b || data.v || data.volume || 0),
          turnover24h: parseFloat(data.q || data.turnover || 0),
          price24hPcnt: parseFloat(data.r || data.c || 0) / 100,
          high24h: parseFloat(data.h || 0),
          low24h: parseFloat(data.l || 0),
          open24h: parseFloat(data.o || 0)
        }
      });
    } else if (ch === 'depth' || ch.startsWith('depth')) {
      this.onDataCallback({
        exchange: 'bitunix',
        channel: 'orderbook',
        symbol,
        data: {
          bids: (data.bids || []).map(([p, q]) => [parseFloat(p), parseFloat(q)]),
          asks: (data.asks || []).map(([p, q]) => [parseFloat(p), parseFloat(q)]),
          timestamp: msg.ts
        }
      });
    } else if (ch === 'trade') {
      const trades = Array.isArray(data) ? data : [data];
      this.onDataCallback({
        exchange: 'bitunix',
        channel: 'trades',
        symbol,
        data: trades.map(t => ({
          price: parseFloat(t.p || t.price || 0),
          size: parseFloat(t.v || t.q || t.qty || t.size || 0),
          side: (t.s || t.m || t.side) === 'buy' ? 'buy' : 'sell',
          timestamp: t.t || t.ts,
          tradeId: t.id
        }))
      });
    } else if (ch.startsWith('market_kline_')) {
      const interval = ch.replace('market_kline_', '');
      const rawT = Number(data.t || data.time || msg.ts || Date.now());
      const tMs = rawT > 1e12 ? rawT : rawT * 1000;
      
      const durations = {
        '1min': 60000, '3min': 180000, '5min': 300000, '15min': 900000, '30min': 1800000,
        '60min': 3600000, '2h': 7200000, '4h': 14400000, '6h': 21600000, '12h': 43200000,
        '1day': 86400000, '1week': 604800000, '1month': 2592000000
      };
      const ms = durations[interval] || 60000;
      const t = Math.floor(tMs / ms) * ms;
      
      this.onDataCallback({
        exchange: 'bitunix',
        channel: 'klines',
        symbol,
        interval,
        data: {
          t,
          o: parseFloat(data.o || data.open || 0),
          h: parseFloat(data.h || data.high || 0),
          l: parseFloat(data.l || data.low || 0),
          c: parseFloat(data.c || data.close || 0),
          v: parseFloat(data.b || data.v || data.volume || 0),
          closed: data.confirm === true || data.confirm === '1'
        }
      });
    }
  }

  _canSubscribe(count = 1) {
    if (this.subscriptionCount + count > SUB_LIMIT) {
      console.error(`[BitunixAdapter] ❌ REJECTED subscription - limit of ${SUB_LIMIT} reached`);
      return false;
    }
    return true;
  }

  subscribeHotSymbols(symbols) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    
    this.hotSymbols = symbols;
    const args = [];
    for (const sym of symbols) {
      args.push({ symbol: sym, ch: 'trade' });
      args.push({ symbol: sym, ch: 'depth' });
      this.activeSubscriptions.add(`trades:${sym}`);
      this.activeSubscriptions.add(`orderbook:${sym}`);
    }
    
    if (!this._canSubscribe(args.length)) return;
    this.subscriptionCount = args.length;

    for (let i = 0; i < args.length; i += 10) {
      const batch = args.slice(i, i + 10);
      this.ws.send(JSON.stringify({ op: 'subscribe', args: batch }));
    }

    this.log(`Subscribed to ${symbols.length} hot symbols (${args.length} topics)`);
  }

  subscribeSymbol(symbol, channels = ['tickers', 'orderbook', 'trades']) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const args = [];
    for (const ch of channels) {
      const key = `${ch}:${symbol}`;
      if (this.activeSubscriptions.has(key)) continue;
      
      if (!this._canSubscribe(1)) break;
      
      if (ch === 'tickers') args.push({ symbol, ch: 'ticker' });
      if (ch === 'orderbook') args.push({ symbol, ch: 'depth' });
      if (ch === 'trades') args.push({ symbol, ch: 'trade' });
      
      this.activeSubscriptions.add(key);
      this.subscriptionCount++;
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
      
      if (ch === 'tickers') args.push({ symbol, ch: 'ticker' });
      if (ch === 'orderbook') args.push({ symbol, ch: 'depth' });
      if (ch === 'trades') args.push({ symbol, ch: 'trade' });
      
      this.activeSubscriptions.delete(key);
      this.subscriptionCount--;
    }

    if (args.length > 0) {
      this.ws.send(JSON.stringify({ op: 'unsubscribe', args }));
    }
  }

  subscribeKline(symbol, interval) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const key = `klines:${symbol}:${interval}`;
    if (this.activeSubscriptions.has(key)) return;
    
    if (!this._canSubscribe(1)) return;
    
    const channelName = `market_kline_${interval}`;
    this.activeSubscriptions.add(key);
    this.subscriptionCount++;
    this.ws.send(JSON.stringify({ op: 'subscribe', args: [{ symbol, ch: channelName }] }));
  }

  unsubscribeKline(symbol, interval) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const key = `klines:${symbol}:${interval}`;
    if (!this.activeSubscriptions.has(key)) return;
    
    const channelName = `market_kline_${interval}`;
    this.activeSubscriptions.delete(key);
    this.subscriptionCount--;
    this.ws.send(JSON.stringify({ op: 'unsubscribe', args: [{ symbol, ch: channelName }] }));
  }
}

module.exports = BitunixAdapter;
