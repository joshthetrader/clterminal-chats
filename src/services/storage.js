// Database and file persistence management

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { DATABASE_URL } = require('../config/constants');

const MESSAGES_FILE = path.join(__dirname, '..', '..', 'data', 'messages.json');
const NEWS_FILE = path.join(__dirname, '..', '..', 'data', 'news.json');

let pgClient = null;
let memoryMessages = [];
let memoryNews = [];
let memoryVolatilityAlerts = [];

// Load messages from file on startup
function loadMessages() {
  try {
    if (fs.existsSync(MESSAGES_FILE)) {
      const data = fs.readFileSync(MESSAGES_FILE, 'utf8');
      memoryMessages = JSON.parse(data) || [];
      console.log(`[Storage] Loaded ${memoryMessages.length} messages from file`);
    } else {
      const dataDir = path.dirname(MESSAGES_FILE);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
    }
  } catch (e) {
    console.error('[Storage] Failed to load messages:', e.message);
    memoryMessages = [];
  }
}

function loadNews() {
  try {
    if (fs.existsSync(NEWS_FILE)) {
      const data = fs.readFileSync(NEWS_FILE, 'utf8');
      memoryNews = JSON.parse(data) || [];
      console.log(`[Storage] Loaded ${memoryNews.length} news items from file`);
    } else {
      const dataDir = path.dirname(NEWS_FILE);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
    }
  } catch (e) {
    console.error('[Storage] Failed to load news:', e.message);
    memoryNews = [];
  }
}

function saveMessages() {
  try {
    const dataDir = path.dirname(MESSAGES_FILE);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    fs.writeFileSync(MESSAGES_FILE, JSON.stringify(memoryMessages, null, 2));
  } catch (e) {
    console.error('[Storage] Failed to save messages:', e.message);
  }
}

function saveNews() {
  try {
    const dataDir = path.dirname(NEWS_FILE);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    fs.writeFileSync(NEWS_FILE, JSON.stringify(memoryNews, null, 2));
  } catch (e) {
    console.error('[Storage] Failed to save news:', e.message);
  }
}

// Initialize PostgreSQL connection and create tables
async function initPostgres() {
  if (!DATABASE_URL) return;
  
  pgClient = new Client({
    connectionString: DATABASE_URL,
    ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : undefined
  });
  
  await pgClient.connect();
  
  await pgClient.query(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      room TEXT NOT NULL,
      user_name TEXT NOT NULL,
      user_color TEXT,
      text TEXT,
      is_trade BOOLEAN DEFAULT FALSE,
      trade_sym TEXT,
      trade_side TEXT,
      trade_lev TEXT,
      trade_entry TEXT,
      reply_to TEXT,
      client_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS chat_messages_room_created_at ON chat_messages(room, created_at DESC);

    CREATE TABLE IF NOT EXISTS news_items (
      id TEXT PRIMARY KEY,
      source_name TEXT,
      source_username TEXT,
      text TEXT,
      url TEXT,
      followers BIGINT,
      images JSONB,
      coin TEXT,
      symbols JSONB,
      is_retweet BOOLEAN DEFAULT FALSE,
      is_quote BOOLEAN DEFAULT FALSE,
      is_reply BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      received_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS news_items_created_at ON news_items(created_at DESC);

    CREATE TABLE IF NOT EXISTS volatility_alerts (
      id TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      exchange TEXT NOT NULL,
      price NUMERIC,
      change_percent NUMERIC,
      volume NUMERIC,
      alert_type TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS volatility_alerts_created_at ON volatility_alerts(created_at DESC);

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      client_order_id TEXT,
      exchange TEXT NOT NULL,
      symbol TEXT NOT NULL,
      side TEXT,
      type TEXT,
      price NUMERIC,
      qty NUMERIC,
      status TEXT,
      client_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_orders_client ON orders(client_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS fills (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      exchange TEXT NOT NULL,
      symbol TEXT NOT NULL,
      price NUMERIC NOT NULL,
      qty NUMERIC NOT NULL,
      fee NUMERIC,
      liquidity TEXT,
      ts TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_fills_order ON fills(order_id, ts DESC);

    CREATE TABLE IF NOT EXISTS order_events (
      id TEXT PRIMARY KEY,
      order_id TEXT REFERENCES orders(id) ON DELETE CASCADE,
      exchange TEXT NOT NULL,
      type TEXT NOT NULL,
      payload JSONB,
      ts TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  
  // Online migrations
  await pgClient.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS client_id TEXT`);
  await pgClient.query(`ALTER TABLE news_items ADD COLUMN IF NOT EXISTS coin TEXT`);
  await pgClient.query(`ALTER TABLE news_items ADD COLUMN IF NOT EXISTS symbols JSONB`);
}

// Persist chat message
async function persistMessage(msg) {
  const {
    id, room, user_name, user_color, text,
    is_trade, trade_sym, trade_side, trade_lev, trade_entry, reply_to, client_id
  } = msg;
  
  if (pgClient) {
    try {
      await pgClient.query(
        `INSERT INTO chat_messages (id, room, user_name, user_color, text, is_trade, trade_sym, trade_side, trade_lev, trade_entry, reply_to, client_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (id) DO NOTHING`,
        [id, room, user_name, user_color, text || null, !!is_trade, trade_sym || null, trade_side || null, trade_lev || null, trade_entry || null, reply_to || null, client_id || null]
      );
    } catch (e) {
      console.error('[Storage] persistMessage error:', e.message);
    }
  } else {
    const memMsg = {
      id, room, user_name, user_color, text: text || null,
      is_trade: !!is_trade, trade_sym: trade_sym || null, trade_side: trade_side || null,
      trade_lev: trade_lev || null, trade_entry: trade_entry || null, reply_to: reply_to || null,
      client_id: client_id || null, ts: Date.now()
    };
    
    memoryMessages.push(memMsg);
    if (memoryMessages.length > 1000) {
      memoryMessages = memoryMessages.slice(-1000);
    }
    saveMessages();
  }
}

module.exports = {
  get pgClient() { return pgClient; },
  get memoryMessages() { return memoryMessages; },
  get memoryNews() { return memoryNews; },
  get memoryVolatilityAlerts() { return memoryVolatilityAlerts; },
  set memoryMessages(m) { memoryMessages = m; },
  set memoryNews(n) { memoryNews = n; },
  set memoryVolatilityAlerts(a) { memoryVolatilityAlerts = a; },
  
  loadMessages,
  loadNews,
  saveMessages,
  saveNews,
  initPostgres,
  persistMessage,
  
  getFileLocation: () => ({ MESSAGES_FILE, NEWS_FILE })
};

