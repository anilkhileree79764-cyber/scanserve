const path = require('path');

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (e) {
  console.error('\n*** Your Node.js is too old. Please install Node.js v22 or newer from https://nodejs.org and run again. ***\n');
  throw e;
}

const dbPath = process.env.DB_PATH || path.join(__dirname, 'cafe.db');
const raw = new DatabaseSync(dbPath);
try { raw.exec('PRAGMA journal_mode = WAL'); } catch { try { raw.exec('PRAGMA journal_mode = DELETE'); } catch {} }
try { raw.exec('PRAGMA foreign_keys = ON'); } catch {}

const db = {
  exec: (sql) => raw.exec(sql),
  prepare: (sql) => {
    const st = raw.prepare(sql);
    return {
      get: (...a) => st.get(...a),
      all: (...a) => st.all(...a),
      run: (...a) => {
        const r = st.run(...a);
        return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
      },
    };
  },
  transaction: (fn) => (...args) => {
    raw.exec('BEGIN');
    try { const out = fn(...args); raw.exec('COMMIT'); return out; }
    catch (e) { try { raw.exec('ROLLBACK'); } catch {} throw e; }
  },
};

db.exec(`
CREATE TABLE IF NOT EXISTS cafes (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_email TEXT, upi_id TEXT,
  plan TEXT DEFAULT 'free', loyalty_rate INTEGER DEFAULT 10, created_at TEXT DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS owners (
  id INTEGER PRIMARY KEY AUTOINCREMENT, cafe_id TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, owner_id INTEGER NOT NULL, cafe_id TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS password_resets (
  token TEXT PRIMARY KEY, owner_id INTEGER NOT NULL, email TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS seats (
  id TEXT PRIMARY KEY, cafe_id TEXT NOT NULL, label TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS menu_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT, cafe_id TEXT NOT NULL, name TEXT NOT NULL, price INTEGER NOT NULL,
  category TEXT DEFAULT 'General', prep_mins INTEGER DEFAULT 10, available INTEGER DEFAULT 1);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT, cafe_id TEXT NOT NULL, name TEXT, phone TEXT NOT NULL,
  points INTEGER DEFAULT 0, visits INTEGER DEFAULT 0, last_visit TEXT DEFAULT (datetime('now')),
  UNIQUE (cafe_id, phone));

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT, cafe_id TEXT NOT NULL, seat_id TEXT, seat_label TEXT,
  customer_id INTEGER, status TEXT DEFAULT 'placed', total INTEGER NOT NULL, pay_method TEXT DEFAULT 'upi',
  paid INTEGER DEFAULT 0, eta_mins INTEGER DEFAULT 10, rating INTEGER, feedback TEXT, notes TEXT,
  rzp_order_id TEXT, rzp_payment_id TEXT, created_at TEXT DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL, item_id INTEGER NOT NULL,
  name TEXT NOT NULL, price INTEGER NOT NULL, qty INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS staff (
  id INTEGER PRIMARY KEY AUTOINCREMENT, cafe_id TEXT NOT NULL, name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL, pass_hash TEXT NOT NULL, role TEXT DEFAULT 'waiter',
  created_at TEXT DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT, cafe_id TEXT NOT NULL, label TEXT NOT NULL,
  amount INTEGER NOT NULL, category TEXT DEFAULT 'General', spent_on TEXT DEFAULT (date('now')),
  created_at TEXT DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, cafe_id TEXT NOT NULL, actor TEXT, action TEXT NOT NULL,
  detail TEXT, created_at TEXT DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS waiter_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT, cafe_id TEXT NOT NULL, seat_id TEXT, seat_label TEXT,
  reason TEXT, resolved INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));

CREATE INDEX IF NOT EXISTS idx_orders_cafe ON orders(cafe_id, status);
`);

// ---- Lightweight migrations: add columns if upgrading an existing DB ----
function addColumn(table, col, def) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); } catch { /* already exists */ }
}
addColumn('menu_items', 'image_url', 'TEXT');
addColumn('menu_items', 'food_type', "TEXT DEFAULT 'veg'");   // veg | nonveg | egg
addColumn('menu_items', 'spicy', 'INTEGER DEFAULT 0');
addColumn('menu_items', 'is_combo', 'INTEGER DEFAULT 0');
addColumn('menu_items', 'station', "TEXT DEFAULT 'Kitchen'"); // Kitchen | Bar | etc.
addColumn('menu_items', 'description', 'TEXT');
addColumn('orders', 'notes', 'TEXT');
addColumn('orders', 'priority', 'INTEGER DEFAULT 0');
addColumn('order_items', 'note', 'TEXT');
addColumn('cafes', 'trial_ends', 'TEXT');
addColumn('cafes', 'logo_url', 'TEXT');
addColumn('cafes', 'brand_color', "TEXT DEFAULT '#b5651d'");
addColumn('cafes', 'google_review_url', 'TEXT');
addColumn('owners', 'email_verified', 'INTEGER DEFAULT 0');
addColumn('owners', 'verify_token', 'TEXT');
addColumn('customers', 'redeemed', 'INTEGER DEFAULT 0');

module.exports = db;
