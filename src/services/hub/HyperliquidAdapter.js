'use strict';

/**
 * Hyperliquid Public WebSocket Adapter
 * Maintains persistent connection to Hyperliquid public streams
 */

const BaseAdapter = require('./BaseAdapter');
const WebSocket = require('ws');

const WS_URL = 'wss://api.hyperliquid.xyz/ws';
const REST_URL = 'https://api.hyperliquid.xyz';

class HyperliquidAdapter extends BaseAdapter {
  constructor(options = {}) {
    super('hyperliquid', WS_URL, options);
    this.assetToIndex = new Map();
  }

  async fetchSymbols() {
    try {
      const res = await fetch(REST_URL + '/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'meta' })
      });
      const data = await res.json();
      if (data && data.universe) {
        this.symbols = data.universe.map((u, idx) => {
          this.assetToIndex.set(u.name, idx);
          return u.name;
        });
        this.log(`Fetched ${this.symbols.length} symbols`);
      }
    } catch (e) {
      console.error('[HyperliquidAdapter] Failed to fetch symbols:', e.message);
    }
  }

  // Override _onOpen for mandatory allMids subscription
  _onOpen() {
    this.ws.send(JSON.stringify({
      method: 'subscribe',
      subscription: { type: 'allMids' }
    }));
    super._onOpen();
  }

  handleMessage(msg) {
    const { channel, data } = msg;
    if (!channel || !data) return;

    if (!this.onDataCallback) return;

    if (channel === 'allMids') {
      if (data.mids) {
        Object.entries(data.mids).forEach(([coin, price]) => {
          this.onDataCallback({
            exchange: 'hyperliquid',
            channel: 'tickers',
            symbol: coin,
            data: {
              lastPrice: parseFloat(price),
              markPrice: parseFloat(price),
              raw: { coin, price }
            }
          });
        });
      }
    } else if (channel === 'trades') {
      const trades = Array.isArray(data) ? data : [data];
      trades.forEach(t => {
        const coin = t.coin || t.s;
        if (!coin) return;
        this.onDataCallback({
          exchange: 'hyperliquid',
          channel: 'trades',
          symbol: coin,
          data: [{
            price: parseFloat(t.px || t.price || 0),
            size: parseFloat(t.sz || t.size || 0),
            side: t.side === 'B' ? 'buy' : 'sell',
            timestamp: t.time || t.ts,
            tradeId: t.tid,
            raw: t
          }]
        });
      });
    } else if (channel === 'l2Book') {
      const coin = data.coin;
      if (!coin) return;
      this.onDataCallback({
        exchange: 'hyperliquid',
        channel: 'orderbook',
        symbol: coin,
        data: {
          bids: (data.levels?.[0] || []).map(l => [parseFloat(l.px), parseFloat(l.sz)]),
          asks: (data.levels?.[1] || []).map(l => [parseFloat(l.px), parseFloat(l.sz)]),
          timestamp: data.time,
          raw: data
        }
      });
    } else if (channel === 'activeAssetCtx') {
      const ctx = data.ctx;
      const coin = data.coin;
      if (!ctx || !coin) return;
      this.onDataCallback({
        exchange: 'hyperliquid',
        channel: 'tickers',
        symbol: coin,
        data: {
          lastPrice: parseFloat(ctx.markPx || 0),
          markPrice: parseFloat(ctx.markPx || 0),
          fundingRate: parseFloat(ctx.funding || 0),
          openInterest: parseFloat(ctx.openInterest || 0),
          volume24h: parseFloat(ctx.dayNtlVlm || 0),
          raw: ctx
        }
      });
    } else if (channel === 'candle') {
      const coin = data.s || data.coin;
      const interval = data.i || msg.subscription?.interval;
      if (!coin || !interval) return;
      this.onDataCallback({
        exchange: 'hyperliquid',
        channel: 'klines',
        symbol: coin,
        interval,
        data: {
          t: parseInt(data.t || data.T || 0),
          o: parseFloat(data.o || 0),
          h: parseFloat(data.h || 0),
          l: parseFloat(data.l || 0),
          c: parseFloat(data.c || 0),
          v: parseFloat(data.v || 0),
          closed: data.x === true,
          raw: data
        }
      });
    }
  }

  subscribeHotSymbols(symbols) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    
    this.hotSymbols = symbols;
    for (const sym of symbols) {
      const coin = sym.replace(/USDT$|USDC$/i, '');
      this.ws.send(JSON.stringify({
        method: 'subscribe',
        subscription: { type: 'trades', coin }
      }));
      this.ws.send(JSON.stringify({
        method: 'subscribe',
        subscription: { type: 'l2Book', coin }
      }));
      this.activeSubscriptions.add(`trades:${coin}`);
      this.activeSubscriptions.add(`orderbook:${coin}`);
    }
    this.log(`Subscribed to ${symbols.length} hot symbols`);
  }

  subscribeSymbol(symbol, channels = ['tickers', 'orderbook', 'trades']) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const coin = symbol.replace(/USDT$|USDC$/i, '');
    for (const ch of channels) {
      const key = `${ch}:${coin}`;
      if (this.activeSubscriptions.has(key)) continue;
      
      const method = 'subscribe';
      if (ch === 'tickers') this.ws.send(JSON.stringify({ method, subscription: { type: 'activeAssetCtx', coin } }));
      if (ch === 'orderbook') this.ws.send(JSON.stringify({ method, subscription: { type: 'l2Book', coin } }));
      if (ch === 'trades') this.ws.send(JSON.stringify({ method, subscription: { type: 'trades', coin } }));
      
      this.activeSubscriptions.add(key);
    }
  }

  unsubscribeSymbol(symbol, channels = ['orderbook', 'trades']) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const coin = symbol.replace(/USDT$|USDC$/i, '');
    for (const ch of channels) {
      const key = `${ch}:${coin}`;
      if (!this.activeSubscriptions.has(key)) continue;
      
      const method = 'unsubscribe';
      if (ch === 'tickers') this.ws.send(JSON.stringify({ method, subscription: { type: 'activeAssetCtx', coin } }));
      if (ch === 'orderbook') this.ws.send(JSON.stringify({ method, subscription: { type: 'l2Book', coin } }));
      if (ch === 'trades') this.ws.send(JSON.stringify({ method, subscription: { type: 'trades', coin } }));
      
      this.activeSubscriptions.delete(key);
    }
  }

  subscribeKline(symbol, interval) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const coin = symbol.replace(/USDT$|USDC$/i, '');
    const key = `klines:${coin}:${interval}`;
    if (this.activeSubscriptions.has(key)) return;
    
    this.activeSubscriptions.add(key);
    this.ws.send(JSON.stringify({
      method: 'subscribe',
      subscription: { type: 'candle', coin, interval }
    }));
  }

  unsubscribeKline(symbol, interval) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const coin = symbol.replace(/USDT$|USDC$/i, '');
    const key = `klines:${coin}:${interval}`;
    if (!this.activeSubscriptions.has(key)) return;
    
    this.activeSubscriptions.delete(key);
    this.ws.send(JSON.stringify({
      method: 'unsubscribe',
      subscription: { type: 'candle', coin, interval }
    }));
  }
}

module.exports = HyperliquidAdapter;
