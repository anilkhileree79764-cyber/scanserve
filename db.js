// Database layer — libSQL/Turso.
// In production set TURSO_DATABASE_URL (+ TURSO_AUTH_TOKEN) to use the free
// durable cloud database. With neither set, it uses a local file (cafe.db) so
// the app still runs offline on your computer exactly as before.
const path = require('path');
const { createClient } = require('@libsql/client');

const remoteUrl = process.env.TURSO_DATABASE_URL;
const url = remoteUrl || ('file:' + (process.env.DB_PATH || path.join(__dirname, 'cafe.db')));
const client = createClient(
  process.env.TURSO_AUTH_TOKEN ? { url, authToken: process.env.TURSO_AUTH_TOKEN } : { url }
);

// libSQL wants args as an array and disallows `undefined` (must be null).
// BigInt ids/rowids are converted back to plain numbers for the app.
const clean = (args) => (args || []).map((v) => (v === undefined ? null : (typeof v === 'bigint' ? Number(v) : v)));
const toResult = (r) => ({
  changes: Number(r.rowsAffected || 0),
  lastInsertRowid: r.lastInsertRowid != null ? Number(r.lastInsertRowid) : undefined,
});

async function exec(sql) { return client.executeMultiple(sql); }
async function get(sql, args) { return (await client.execute({ sql, args: clean(args) })).rows[0]; }
async function all(sql, args) { return (await client.execute({ sql, args: clean(args) })).rows; }
async function run(sql, args) { return toResult(await client.execute({ sql, args: clean(args) })); }

const db = {
  raw: client,
  isRemote: !!remoteUrl,
  exec,
  // prepare() mirrors the old synchronous interface but returns promises,
  // so call sites just add `await`. SQL strings are unchanged.
  prepare: (sql) => ({
    get: (...a) => get(sql, a),
    all: (...a) => all(sql, a),
    run: (...a) => run(sql, a),
  }),
  // Interactive write transaction. Usage:
  //   const tx = await db.begin();
  //   try { await tx.prepare(sql).run(...); ...; await tx.commit(); }
  //   catch (e) { await tx.rollback(); throw e; }
  begin: async () => {
    const t = await client.transaction('write');
    const wrap = (sql) => ({
      get: (...a) => t.execute({ sql, args: clean(a) }).then((r) => r.rows[0]),
      all: (...a) => t.execute({ sql, args: clean(a) }).then((r) => r.rows),
      run: (...a) => t.execute({ sql, args: clean(a) }).then(toResult),
    });
    return { prepare: wrap, commit: () => t.commit(), rollback: () => t.rollback() };
  },
};

// Create schema + run lightweight migrations. Must be awaited before serving.
async function init() {
  await exec(`
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

  // Lightweight migrations — add columns if upgrading an existing DB.
  const addColumn = async (table, col, def) => {
    try { await exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); } catch { /* already exists */ }
  };
  await addColumn('menu_items', 'image_url', 'TEXT');
  await addColumn('menu_items', 'food_type', "TEXT DEFAULT 'veg'");
  await addColumn('menu_items', 'spicy', 'INTEGER DEFAULT 0');
  await addColumn('menu_items', 'is_combo', 'INTEGER DEFAULT 0');
  await addColumn('menu_items', 'station', "TEXT DEFAULT 'Kitchen'");
  await addColumn('menu_items', 'description', 'TEXT');
  await addColumn('orders', 'notes', 'TEXT');
  await addColumn('orders', 'priority', 'INTEGER DEFAULT 0');
  await addColumn('order_items', 'note', 'TEXT');
  await addColumn('cafes', 'trial_ends', 'TEXT');
  await addColumn('cafes', 'paid_until', 'TEXT');
  await addColumn('sessions', 'actor_kind', "TEXT DEFAULT 'owner'");
  await addColumn('cafes', 'logo_url', 'TEXT');
  await addColumn('cafes', 'brand_color', "TEXT DEFAULT '#b5651d'");
  await addColumn('cafes', 'google_review_url', 'TEXT');
  await addColumn('owners', 'email_verified', 'INTEGER DEFAULT 0');
  await addColumn('owners', 'verify_token', 'TEXT');
  await addColumn('customers', 'redeemed', 'INTEGER DEFAULT 0');
}

db.init = init;
module.exports = db;
