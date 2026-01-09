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
      is_layout BOOLEAN DEFAULT FALSE,
      layout_name TEXT,
      layout_window_count INTEGER,
      layout_windows JSONB,
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
      time_period INTEGER DEFAULT 30,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS volatility_alerts_created_at ON volatility_alerts(created_at DESC);
    
    -- Migration: Add time_period column if it doesn't exist (for existing tables)
    DO $$ 
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'volatility_alerts' AND column_name = 'time_period'
      ) THEN
        ALTER TABLE volatility_alerts ADD COLUMN time_period INTEGER DEFAULT 30;
      END IF;
    END $$;

    -- Drop unused tables if they exist
    DROP TABLE IF EXISTS fills CASCADE;
    DROP TABLE IF EXISTS order_events CASCADE;
    DROP TABLE IF EXISTS orders CASCADE;

    -- Create new trade_events table
    CREATE TABLE IF NOT EXISTS trade_events (
      id SERIAL PRIMARY KEY,
      exchange TEXT NOT NULL,
      event TEXT NOT NULL,
      payload JSONB,
      ts TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_trade_events_ts ON trade_events(ts DESC);
  `);
  
  // Online migrations
  await pgClient.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS client_id TEXT`);
  await pgClient.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS is_layout BOOLEAN DEFAULT FALSE`);
  await pgClient.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS layout_name TEXT`);
  await pgClient.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS layout_window_count INTEGER`);
  await pgClient.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS layout_windows JSONB`);
  await pgClient.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS trade_take_profit TEXT`);
  await pgClient.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS trade_stop_loss TEXT`);
  await pgClient.query(`ALTER TABLE news_items ADD COLUMN IF NOT EXISTS coin TEXT`);
  await pgClient.query(`ALTER TABLE news_items ADD COLUMN IF NOT EXISTS symbols JSONB`);
  await pgClient.query(`ALTER TABLE news_items ADD COLUMN IF NOT EXISTS suggestions JSONB`);
  // Order sharing columns
  await pgClient.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS is_order BOOLEAN DEFAULT FALSE`);
  await pgClient.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS order_sym TEXT`);
  await pgClient.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS order_side TEXT`);
  await pgClient.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS order_lev TEXT`);
  await pgClient.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS order_price TEXT`);
  await pgClient.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS order_qty TEXT`);
  await pgClient.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS order_type TEXT`);
  await pgClient.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS order_take_profit TEXT`);
  await pgClient.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS order_stop_loss TEXT`);
}

// Persist chat message
async function persistMessage(msg) {
  const {
    id, room, user_name, user_color, text,
    is_trade, trade_sym, trade_side, trade_lev, trade_entry, trade_take_profit, trade_stop_loss,
    is_layout, layout_name, layout_window_count, layout_windows,
    is_order, order_sym, order_side, order_lev, order_price, order_qty, order_type, order_take_profit, order_stop_loss,
    reply_to, client_id
  } = msg;
  
  if (pgClient) {
    try {
      await pgClient.query(
        `INSERT INTO chat_messages (id, room, user_name, user_color, text, is_trade, trade_sym, trade_side, trade_lev, trade_entry, trade_take_profit, trade_stop_loss, is_layout, layout_name, layout_window_count, layout_windows, is_order, order_sym, order_side, order_lev, order_price, order_qty, order_type, order_take_profit, order_stop_loss, reply_to, client_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27) ON CONFLICT (id) DO NOTHING`,
        [id, room, user_name, user_color, text || null, !!is_trade, trade_sym || null, trade_side || null, trade_lev || null, trade_entry || null, trade_take_profit || null, trade_stop_loss || null, !!is_layout, layout_name || null, layout_window_count || null, layout_windows || null, !!is_order, order_sym || null, order_side || null, order_lev || null, order_price || null, order_qty || null, order_type || null, order_take_profit || null, order_stop_loss || null, reply_to || null, client_id || null]
      );
    } catch (e) {
      console.error('[Storage] persistMessage error:', e.message);
    }
  } else {
    const memMsg = {
      id, room, user_name, user_color, text: text || null,
      is_trade: !!is_trade, trade_sym: trade_sym || null, trade_side: trade_side || null,
      trade_lev: trade_lev || null, trade_entry: trade_entry || null,
      trade_take_profit: trade_take_profit || null, trade_stop_loss: trade_stop_loss || null,
      is_layout: !!is_layout, layout_name: layout_name || null, layout_window_count: layout_window_count || null,
      layout_windows: layout_windows || null,
      is_order: !!is_order, order_sym: order_sym || null, order_side: order_side || null,
      order_lev: order_lev || null, order_price: order_price || null, order_qty: order_qty || null,
      order_type: order_type || null, order_take_profit: order_take_profit || null, order_stop_loss: order_stop_loss || null,
      reply_to: reply_to || null, client_id: client_id || null, ts: Date.now()
    };
    
    memoryMessages.push(memMsg);
    if (memoryMessages.length > 1000) {
      memoryMessages = memoryMessages.slice(-1000);
    }
    saveMessages();
  }
}

// Persist trade event
async function persistTradeEvent(exchange, event, payload) {
  if (pgClient) {
    try {
      await pgClient.query(
        `INSERT INTO trade_events (exchange, event, payload) VALUES ($1, $2, $3)`,
        [exchange, event, typeof payload === 'string' ? payload : JSON.stringify(payload)]
      );
    } catch (e) {
      console.error('[Storage] persistTradeEvent error:', e.message);
    }
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
  persistTradeEvent,
  
  getFileLocation: () => ({ MESSAGES_FILE, NEWS_FILE })
};

