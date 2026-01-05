'use strict';

const WebSocket = require('ws');

/**
 * BaseAdapter - Abstract parent for all exchange WebSocket adapters
 * Handles common lifecycle: connect, close, reconnect, ping, status tracking.
 */
class BaseAdapter {
  constructor(name, wsUrl, options = {}) {
    this.name = name;
    this.wsUrl = wsUrl;
    this.debug = options.debug || false;
    
    this.ws = null;
    this.connected = false;
    this.symbols = [];
    this.hotSymbols = [];
    this.activeSubscriptions = new Set();
    
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.pingInterval = options.pingInterval || 20000;
    
    this.onDataCallback = null;
    this.onStatusCallback = null;
    this.lastUpdate = 0;
  }

  log(...args) {
    if (this.debug) console.log(`[${this.name.toUpperCase()}Adapter]`, ...args);
  }

  // To be implemented by subclasses
  async fetchSymbols() {
    throw new Error('fetchSymbols() must be implemented by subclass');
  }

  // To be implemented by subclasses
  handleMessage(msg) {
    throw new Error('handleMessage() must be implemented by subclass');
  }

  async connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    await this.fetchSymbols();

    return new Promise((resolve) => {
      try {
        this.ws = new WebSocket(this.wsUrl);

        this.ws.on('open', () => {
          this.log('Connected');
          this.connected = true;
          this.reconnectAttempts = 0;
          this.activeSubscriptions.clear();
          this.startPing();
          
          // Hook for subclasses to do extra setup on open
          this._onOpen();
          
          this.onStatusCallback?.({ exchange: this.name, connected: true });
          resolve(true);
        });

        this.ws.on('message', (raw) => {
          const str = raw.toString();
          if (this._isPong(str)) return;
          
          try {
            const msg = JSON.parse(str);
            if (this._handleInternalMessage(msg)) return;
            
            this.lastUpdate = Date.now();
            this.handleMessage(msg);
          } catch (e) {
            // Some exchanges send raw strings that aren't JSON
            if (str === 'pong') return;
            console.error(`[${this.name.toUpperCase()}Adapter] Parse error:`, e.message, str.substring(0, 100));
          }
        });

        this.ws.on('close', (code) => {
          console.warn(`[${this.name.toUpperCase()}Adapter] Disconnected (code: ${code})`);
          this.connected = false;
          this.stopPing();
          this.onStatusCallback?.({ exchange: this.name, connected: false });
          this.scheduleReconnect();
        });

        this.ws.on('error', (err) => {
          console.error(`[${this.name.toUpperCase()}Adapter] WebSocket error:`, err.message);
        });

      } catch (e) {
        console.error(`[${this.name.toUpperCase()}Adapter] Connection failed:`, e.message);
        this.scheduleReconnect();
        resolve(false);
      }
    });
  }

  // Hook for subclasses
  _onOpen() {
    // Re-subscribe to hot symbols on reconnect if they exist
    if (this.hotSymbols.length > 0) {
      this.subscribeHotSymbols(this.hotSymbols);
    }
  }

  // Check if message is a pong response
  _isPong(str) {
    return str === 'pong' || str === '{"op":"pong"}' || str === '{"event":"pong"}';
  }

  // Handle common exchange-level messages like error or success notifications
  _handleInternalMessage(msg) {
    if (msg.op === 'pong' || msg.event === 'pong' || msg.channel === 'pong') return true;
    if (msg.success === false || msg.event === 'error' || msg.code !== undefined && msg.code !== 0 && msg.code !== '0') {
      console.warn(`[${this.name.toUpperCase()}Adapter] Warning:`, msg.ret_msg || msg.msg || msg.message || msg);
      return true;
    }
    // If it's just a subscription success message, consume it
    if (msg.op === 'subscribe' || msg.event === 'subscribe' || (msg.op === 'connect' && this.name === 'bitunix')) {
      return true;
    }
    return false;
  }

  startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ op: 'ping' }));
      }
    }, this.pingInterval);
  }

  stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;

    console.log(`[${this.name.toUpperCase()}Adapter] Reconnecting in ${delay}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  onData(callback) {
    this.onDataCallback = callback;
  }

  onStatus(callback) {
    this.onStatusCallback = callback;
  }

  isConnected() {
    return this.connected && this.ws?.readyState === WebSocket.OPEN;
  }

  getSymbolCount() {
    return this.symbols.length;
  }

  getLastUpdate() {
    return this.lastUpdate;
  }

  close() {
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners(); // Prevent close events during manual close
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }
}

module.exports = BaseAdapter;



