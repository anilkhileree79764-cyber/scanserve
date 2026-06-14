const express = require('express');
const path = require('path');
const db = require('./db');
const auth = require('./auth');
const payments = require('./payments');
const notify = require('./notify');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const getCafe = (id) => db.prepare('SELECT * FROM cafes WHERE id = ?').get(id);

// ===== AUTH =====

app.post('/api/auth/register', (req, res) => {
  const { cafe_name, email, password, upi_id } = req.body;
  if (!cafe_name || !email || !password) return res.status(400).json({ error: 'Missing fields' });
  if (db.prepare('SELECT 1 FROM owners WHERE email = ?').get(email))
    return res.status(409).json({ error: 'Email already registered' });

  const cafeId = 'cafe_' + Math.random().toString(36).slice(2, 8);
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO cafes (id,name,owner_email,upi_id) VALUES (?,?,?,?)')
      .run(cafeId, cafe_name, email, upi_id || null);
    const r = db.prepare('INSERT INTO owners (cafe_id,email,pass_hash) VALUES (?,?,?)')
      .run(cafeId, email, auth.hashPassword(password));
    return { id: r.lastInsertRowid, cafe_id: cafeId };
  });
  const owner = tx();
  const token = auth.createSession(owner);
  res.json({ ok: true, token, cafe_id: cafeId, cafe_name });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  const owner = db.prepare('SELECT * FROM owners WHERE email = ?').get(email);
  if (!owner || !auth.verifyPassword(password, owner.pass_hash))
    return res.status(401).json({ error: 'Wrong email or password' });
  const token = auth.createSession(owner);
  const cafe = getCafe(owner.cafe_id);
  res.json({ ok: true, token, cafe_id: owner.cafe_id, cafe_name: cafe.name });
});

app.get('/api/auth/me', auth.requireAuth, (req, res) => {
  const cafe = getCafe(req.cafe_id);
  res.json({ cafe_id: cafe.id, cafe_name: cafe.name });
});

// ===== PUBLIC (customer) =====

app.get('/api/scan/:seatId', (req, res) => {
  const seat = db.prepare('SELECT * FROM seats WHERE id = ?').get(req.params.seatId);
  if (!seat) return res.status(404).json({ error: 'Unknown QR code' });
  const cafe = getCafe(seat.cafe_id);
  const menu = db.prepare(
    'SELECT id,name,price,category,prep_mins,available FROM menu_items WHERE cafe_id = ? ORDER BY category,name'
  ).all(seat.cafe_id);
  res.json({ cafe: { id: cafe.id, name: cafe.name, upi_id: cafe.upi_id }, seat, menu });
});

app.post('/api/order', (req, res) => {
  const { cafe_id, seat_id, items, name, phone, pay_method } = req.body;
  const cafe = getCafe(cafe_id);
  if (!cafe) return res.status(404).json({ error: 'Cafe not found' });
  if (!items || !items.length) return res.status(400).json({ error: 'Cart is empty' });
  if (!phone) return res.status(400).json({ error: 'Phone required for receipt & loyalty' });

  const seat = seat_id ? db.prepare('SELECT * FROM seats WHERE id = ?').get(seat_id) : null;

  let total = 0, eta = 0;
  const resolved = [];
  for (const line of items) {
    const m = db.prepare('SELECT * FROM menu_items WHERE id = ? AND cafe_id = ?').get(line.id, cafe_id);
    if (!m) return res.status(400).json({ error: `Item ${line.id} not on menu` });
    if (!m.available) return res.status(409).json({ error: `${m.name} is sold out` });
    const qty = Math.max(1, parseInt(line.qty) || 1);
    total += m.price * qty;
    eta = Math.max(eta, m.prep_mins);
    resolved.push({ id: m.id, name: m.name, price: m.price, qty });
  }

  const tx = db.transaction(() => {
    let cust = db.prepare('SELECT * FROM customers WHERE cafe_id = ? AND phone = ?').get(cafe_id, phone);
    if (cust) {
      db.prepare("UPDATE customers SET name=COALESCE(?,name), visits=visits+1, last_visit=datetime('now') WHERE id=?")
        .run(name || null, cust.id);
    } else {
      const r = db.prepare('INSERT INTO customers (cafe_id,name,phone,visits) VALUES (?,?,?,1)')
        .run(cafe_id, name || null, phone);
      cust = { id: r.lastInsertRowid, points: 0 };
    }
    const o = db.prepare(
      `INSERT INTO orders (cafe_id,seat_id,seat_label,customer_id,total,pay_method,eta_mins)
       VALUES (?,?,?,?,?,?,?)`
    ).run(cafe_id, seat_id || null, seat ? seat.label : 'Takeaway', cust.id, total, pay_method || 'upi', eta);
    const insItem = db.prepare('INSERT INTO order_items (order_id,item_id,name,price,qty) VALUES (?,?,?,?,?)');
    for (const it of resolved) insItem.run(o.lastInsertRowid, it.id, it.name, it.price, it.qty);
    const earned = Math.floor((total / 100) * cafe.loyalty_rate / 100);
    db.prepare('UPDATE customers SET points = points + ? WHERE id = ?').run(earned, cust.id);
    return { orderId: o.lastInsertRowid, earned };
  });

  const out = tx();
  res.json({ ok: true, orderId: out.orderId, total, eta_mins: eta, points_earned: out.earned });
});

app.get('/api/order/:id/status', (req, res) => {
  const o = db.prepare('SELECT id,status,eta_mins,created_at,total,paid FROM orders WHERE id = ?').get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  const elapsed = Math.floor((Date.now() - new Date(o.created_at + 'Z').getTime()) / 60000);
  o.remaining_mins = Math.max(0, o.eta_mins - elapsed);
  res.json(o);
});

app.post('/api/order/:id/feedback', (req, res) => {
  const { rating, feedback } = req.body;
  db.prepare('UPDATE orders SET rating=?, feedback=? WHERE id=?').run(rating || null, feedback || null, req.params.id);
  res.json({ ok: true });
});

// ===== PAYMENTS =====

app.post('/api/order/:id/pay', async (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  try {
    const rzp = await payments.createOrder(o.total, `order_${o.id}`);
    db.prepare('UPDATE orders SET rzp_order_id=? WHERE id=?').run(rzp.order_id, o.id);
    res.json({ ...rzp, amount: o.total });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/order/:id/pay/verify', (req, res) => {
  const { rzp_order_id, rzp_payment_id, signature } = req.body;
  if (!payments.verifySignature(rzp_order_id, rzp_payment_id, signature))
    return res.status(400).json({ error: 'Payment verification failed' });
  db.prepare('UPDATE orders SET paid=1, rzp_payment_id=? WHERE id=?').run(rzp_payment_id || 'demo', req.params.id);
  res.json({ ok: true });
});

// ===== OWNER (protected) =====

app.get('/api/cafe/:cafeId/orders', auth.requireAuth, (req, res) => {
  const orders = db.prepare('SELECT * FROM orders WHERE cafe_id = ? ORDER BY created_at DESC LIMIT 100').all(req.params.cafeId);
  const getItems = db.prepare('SELECT name,qty FROM order_items WHERE order_id = ?');
  for (const o of orders) o.items = getItems.all(o.id);
  res.json(orders);
});

app.post('/api/order/:id/status', auth.requireAuth, (req, res) => {
  const allowed = ['placed', 'preparing', 'ready', 'served'];
  if (!allowed.includes(req.body.status)) return res.status(400).json({ error: 'Bad status' });
  const o = db.prepare('SELECT cafe_id FROM orders WHERE id = ?').get(req.params.id);
  if (!o || o.cafe_id !== req.cafe_id) return res.status(403).json({ error: 'Not your order' });
  db.prepare('UPDATE orders SET status=? WHERE id=?').run(req.body.status, req.params.id);
  res.json({ ok: true });
});

app.post('/api/order/:id/paid', auth.requireAuth, (req, res) => {
  const o = db.prepare('SELECT cafe_id FROM orders WHERE id = ?').get(req.params.id);
  if (!o || o.cafe_id !== req.cafe_id) return res.status(403).json({ error: 'Not your order' });
  db.prepare('UPDATE orders SET paid=1 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/cafe/:cafeId/menu', auth.requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM menu_items WHERE cafe_id = ? ORDER BY category,name').all(req.params.cafeId));
});

app.post('/api/menu/:id/available', auth.requireAuth, (req, res) => {
  const m = db.prepare('SELECT cafe_id FROM menu_items WHERE id = ?').get(req.params.id);
  if (!m || m.cafe_id !== req.cafe_id) return res.status(403).json({ error: 'Not your item' });
  db.prepare('UPDATE menu_items SET available=? WHERE id=?').run(req.body.available ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

app.post('/api/cafe/:cafeId/menu', auth.requireAuth, (req, res) => {
  const { name, price, category, prep_mins } = req.body;
  if (!name || !(price >= 0)) return res.status(400).json({ error: 'Name and price required' });
  const r = db.prepare('INSERT INTO menu_items (cafe_id,name,price,category,prep_mins) VALUES (?,?,?,?,?)')
    .run(req.cafe_id, name, Math.round(price), category || 'General', parseInt(prep_mins) || 10);
  res.json({ ok: true, id: r.lastInsertRowid });
});

app.post('/api/menu/:id', auth.requireAuth, (req, res) => {
  const m = db.prepare('SELECT cafe_id FROM menu_items WHERE id = ?').get(req.params.id);
  if (!m || m.cafe_id !== req.cafe_id) return res.status(403).json({ error: 'Not your item' });
  const { name, price, category, prep_mins } = req.body;
  db.prepare('UPDATE menu_items SET name=?, price=?, category=?, prep_mins=? WHERE id=?')
    .run(name, Math.round(price), category || 'General', parseInt(prep_mins) || 10, req.params.id);
  res.json({ ok: true });
});

app.post('/api/menu/:id/delete', auth.requireAuth, (req, res) => {
  const m = db.prepare('SELECT cafe_id FROM menu_items WHERE id = ?').get(req.params.id);
  if (!m || m.cafe_id !== req.cafe_id) return res.status(403).json({ error: 'Not your item' });
  db.prepare('DELETE FROM menu_items WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/cafe/:cafeId/customers', auth.requireAuth, (req, res) => {
  res.json(db.prepare('SELECT name,phone,points,visits,last_visit FROM customers WHERE cafe_id = ? ORDER BY last_visit DESC').all(req.params.cafeId));
});

app.get('/api/cafe/:cafeId/winback', auth.requireAuth, (req, res) => {
  const days = parseInt(req.query.days) || 30;
  const rows = db.prepare(
    `SELECT name,phone,points,visits,last_visit FROM customers
      WHERE cafe_id = ? AND last_visit <= datetime('now', ?) ORDER BY last_visit ASC`
  ).all(req.params.cafeId, `-${days} days`);
  res.json({ days, count: rows.length, customers: rows });
});

app.post('/api/cafe/:cafeId/winback/send', auth.requireAuth, async (req, res) => {
  const days = parseInt(req.body.days) || 30;
  const offer = req.body.message || "We miss you! Here's 10% off your next visit. See you soon";
  const cafe = getCafe(req.params.cafeId);
  const rows = db.prepare(
    `SELECT name,phone FROM customers WHERE cafe_id = ? AND last_visit <= datetime('now', ?)`
  ).all(req.params.cafeId, `-${days} days`);
  let sent = 0;
  for (const c of rows) {
    const msg = `Hi ${c.name || 'there'}, ${cafe.name}: ${offer}`;
    if (await notify.sendMessage(c.phone, msg)) sent++;
  }
  res.json({ ok: true, sent, total: rows.length });
});

app.get('/api/cafe/:cafeId/stats', auth.requireAuth, (req, res) => {
  const c = req.params.cafeId;
  const today = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(total),0) rev FROM orders WHERE cafe_id=? AND date(created_at)=date('now')`).get(c);
  const active = db.prepare(`SELECT COUNT(*) n FROM orders WHERE cafe_id=? AND status IN ('placed','preparing','ready')`).get(c);
  res.json({ orders_today: today.n, revenue_today: today.rev, active_orders: active.n });
});

app.get('/api/cafe/:cafeId/seats', auth.requireAuth, (req, res) => {
  res.json(db.prepare('SELECT id,label FROM seats WHERE cafe_id = ? ORDER BY label').all(req.params.cafeId));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Cafe SaaS running: http://localhost:${PORT}  (payments: ${payments.LIVE ? 'LIVE' : 'demo'})`));
