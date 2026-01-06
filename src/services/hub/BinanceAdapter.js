const WebSocket = require('ws');
const BaseAdapter = require('./BaseAdapter');

const WS_URL = 'wss://fstream.binance.com/ws';
const REST_URL = 'https://fapi.binance.com';

class BinanceAdapter extends BaseAdapter {
  constructor(options = {}) {
    super('binance', WS_URL, options);
    this.restUrl = REST_URL;
    this.subscribedSymbols = new Set();
  }

  async fetchSymbols() {
    try {
      const res = await this.fetchWithTimeout(`${this.restUrl}/fapi/v1/exchangeInfo`);
      const data = await res.json();
      if (data.symbols && Array.isArray(data.symbols)) {
        this.symbols = data.symbols
          .filter(s => s.status === 'TRADING' && s.quoteAsset === 'USDT')
          .map(s => s.symbol);
        this.log(`Fetched ${this.symbols.length} symbols`);
      }
    } catch (e) {
      console.error('[BinanceAdapter] Failed to fetch symbols:', e.message);
      this.symbols = [];
    }
  }

  // Called when WebSocket connects - subscribe to ALL liquidations immediately
  _onOpen() {
    this.subscribeAllLiquidations();
  }

  subscribeAllLiquidations() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.activeSubscriptions.has('liquidations:ALL')) return;
    
    // Use the global liquidation stream instead of individual symbol streams
    const msg = {
      method: 'SUBSCRIBE',
      params: ['!forceOrder@arr'],
      id: Date.now()
    };
    
    this.ws.send(JSON.stringify(msg));
    this.activeSubscriptions.add('liquidations:ALL');
    this.log('Subscribed to !forceOrder@arr (all liquidations)');
  }

  getSubscriptionMessage(symbol) {
    // For "ALL" market liquidations, use '!forceOrder@arr'
    // For specific symbol: '<symbol>@forceOrder'
    const topic = symbol === 'ALL' ? '!forceOrder@arr' : `${symbol.toLowerCase()}@forceOrder`;
    
    return {
      method: 'SUBSCRIBE',
      params: [topic],
      id: Date.now()
    };
  }

  getUnsubscriptionMessage(symbol) {
    const topic = symbol === 'ALL' ? '!forceOrder@arr' : `${symbol.toLowerCase()}@forceOrder`;
    return {
      method: 'UNSUBSCRIBE',
      params: [topic],
      id: Date.now()
    };
  }

  normalizeSymbol(symbol) {
    return symbol.toUpperCase();
  }

  handleMessage(data) {
    try {
      const msg = typeof data === 'string' ? JSON.parse(data) : data;
      
      // Binance often wraps payload in {"stream": "...", "data": {...}} for combined streams,
      // but raw streams send direct objects. We check both.
      let payload = msg;
      if (msg.stream && msg.data) {
        payload = msg.data;
      }
      
      // Check for forceOrder event
      if (payload.e === 'forceOrder') {
          const o = payload.o;
          // o.s = Symbol
          // o.S = Side (SELL/BUY)
          // o.q = Original Qty
          // o.p = Price
          // o.X = Status (FILLED)
          // o.ap = Average Price
          // o.l = Last Filled Qty
          // o.z = Accumulated Filled Qty
          // o.T = Trade Time
          
          // Liquidated SELL means they were LONG. Liquidated BUY means they were SHORT.
          const side = o.S === 'SELL' ? 'Long' : 'Short'; 
          
          if (this.onDataCallback) {
            this.onDataCallback({
                exchange: 'binance',
                channel: 'liquidations',
                symbol: o.s,
                data: {
                    id: `${o.s}-${o.S}-${o.q}-${o.p}-${o.T}`,
                    symbol: o.s,
                    s: o.s,
                    side: side,
                    S: o.S,
                    size: parseFloat(o.q),
                    v: parseFloat(o.q),
                    price: parseFloat(o.ap),
                    p: parseFloat(o.ap),
                    value: parseFloat(o.q) * parseFloat(o.ap),
                    timestamp: o.T,
                    T: o.T,
                    exchange: 'binance'
                }
            });
          }
      }
    } catch (e) {
      // Ignore parse errors or non-json messages
    }
  }

  /**
   * Subscribe to liquidations - Binance uses !forceOrder@arr for ALL symbols
   * Called by DemandTracker when client subscribes
   */
  subscribeLiquidation(symbol) {
    // All liquidations are already subscribed via subscribeAllLiquidations() on _onOpen
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

module.exports = BinanceAdapter;
