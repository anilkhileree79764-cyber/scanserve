// Smoke tests for ScanServe. Boots the real server against a throwaway DB
// and exercises the critical paths. Run with:  npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const PORT = 4100 + Math.floor(Math.random() * 800);
const BASE = `http://localhost:${PORT}`;
const DB_PATH = path.join(os.tmpdir(), `scanserve-test-${Date.now()}.db`);
let server;

function post(url, body, token) {
  return fetch(BASE + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(body || {}),
  });
}
function get(url, token) {
  return fetch(BASE + url, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
}

before(async () => {
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DB_PATH, NODE_ENV: 'test' },
    stdio: 'ignore',
  });
  // wait for health
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(BASE + '/healthz'); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});

after(() => {
  if (server) server.kill();
  try { fs.unlinkSync(DB_PATH); } catch {}
  try { fs.unlinkSync(DB_PATH + '-wal'); } catch {}
  try { fs.unlinkSync(DB_PATH + '-shm'); } catch {}
});

// shared state across tests
const S = {};

test('health check', async () => {
  const r = await get('/healthz');
  assert.equal(r.status, 200);
});

test('CSP allows inline on* handlers (onclick) — UI buttons depend on it', async () => {
  const r = await get('/login.html');
  const csp = r.headers.get('content-security-policy') || '';
  // helmet defaults to `script-src-attr 'none'` which silently kills every inline onclick
  assert.ok(/script-src-attr[^;]*'unsafe-inline'/.test(csp), 'script-src-attr must allow unsafe-inline, got: ' + csp);
  assert.ok(!/script-src-attr 'none'/.test(csp), 'script-src-attr must not be none');
});

test('register creates a cafe with trial + starter data', async () => {
  const r = await post('/api/auth/register', { cafe_name: 'TestCafe', email: `o${Date.now()}@t.com`, password: 'password123' });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.ok(d.token && d.cafe_id && d.is_new);
  S.cafe = d.cafe_id; S.token = d.token;
  const seats = await (await get(`/api/cafe/${S.cafe}/seats`, S.token)).json();
  assert.ok(seats.length >= 4, 'starter tables seeded');
  S.seat = seats[0].id;
});

test('scan returns menu with new fields + branding', async () => {
  const d = await (await get(`/api/scan/${S.seat}`)).json();
  assert.ok(d.menu.length > 0);
  assert.ok(d.cafe.brand_color);
  assert.ok('food_type' in d.menu[0]);
  S.item = d.menu[0].id;
});

test('placing an order works while in trial, with item notes', async () => {
  const r = await post('/api/order', { cafe_id: S.cafe, seat_id: S.seat, phone: '9876543210', name: 'A', notes: 'x', items: [{ id: S.item, qty: 2, note: 'no onion' }] });
  assert.equal(r.status, 200);
  const d = await r.json();
  S.order = d.orderId;
  const orders = await (await get(`/api/cafe/${S.cafe}/orders`, S.token)).json();
  assert.equal(orders[0].items[0].note, 'no onion');
  assert.ok(orders[0].stations.length >= 1);
});

test('report computes profit = revenue - expenses', async () => {
  await post(`/api/cafe/${S.cafe}/expenses`, { label: 'Milk', amount: 5000 }, S.token);
  const rep = await (await get(`/api/cafe/${S.cafe}/report`, S.token)).json();
  assert.equal(rep.profit, rep.revenue - rep.expenses);
});

test('photo upload stores an image and returns a url', async () => {
  // 1x1 transparent PNG
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const r = await post(`/api/cafe/${S.cafe}/upload`, { data: png }, S.token);
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.match(d.url, /^\/uploads\/.+\.png$/);
  // file is actually served
  const img = await get(d.url);
  assert.equal(img.status, 200);
});

test('billing (demo) activates a paid plan', async () => {
  const start = await (await post(`/api/cafe/${S.cafe}/billing/start`, {}, S.token)).json();
  assert.ok(start.demo, 'demo billing without keys');
  const v = await post(`/api/cafe/${S.cafe}/billing/verify`, { rzp_order_id: start.order_id, rzp_payment_id: 'demo', signature: 'demo' }, S.token);
  const d = await v.json();
  assert.ok(d.ok && d.plan === 'paid');
  const t = await (await get(`/api/cafe/${S.cafe}/trial`, S.token)).json();
  assert.equal(t.plan, 'paid');
  assert.ok(t.active);
});

test('bulk table creation adds numbered tables', async () => {
  const before = (await (await get(`/api/cafe/${S.cafe}/seats`, S.token)).json()).length;
  const r = await post(`/api/cafe/${S.cafe}/seats/bulk`, { count: 12 }, S.token);
  const d = await r.json();
  assert.equal(d.created, 12);
  const after = (await (await get(`/api/cafe/${S.cafe}/seats`, S.token)).json()).length;
  assert.equal(after, before + 12);
});

test('expired free cafe is blocked from taking online orders (the paywall)', async () => {
  // open the same DB the server uses and force this cafe's trial to expire
  process.env.DB_PATH = DB_PATH;
  delete require.cache[require.resolve('../db')];
  const db = require('../db');
  await db.prepare("UPDATE cafes SET plan='free', paid_until=NULL, trial_ends=datetime('now','-1 day') WHERE id=?").run(S.cafe);
  const r = await post('/api/order', { cafe_id: S.cafe, seat_id: S.seat, phone: '9876543210', items: [{ id: S.item, qty: 1 }] });
  assert.equal(r.status, 402, 'order should be refused with 402 Payment Required');
});

test('staff cannot manage staff (owner-only guard)', async () => {
  const email = `w${Date.now()}@t.com`;
  const add = await post(`/api/cafe/${S.cafe}/staff`, { name: 'Ravi', email, password: 'waiterpass1', role: 'waiter' }, S.token);
  assert.equal(add.status, 200);
  const login = await (await post('/api/auth/login', { email, password: 'waiterpass1' })).json();
  assert.equal(login.role, 'waiter');
  // staff tries to add another staff → 403
  const blocked = await post(`/api/cafe/${S.cafe}/staff`, { name: 'X', email: `z${Date.now()}@t.com`, password: 'password12', role: 'waiter' }, login.token);
  assert.equal(blocked.status, 403);
});
