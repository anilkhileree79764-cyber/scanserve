const express = require('express');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const db = require('./db');
const auth = require('./auth');
const payments = require('./payments');
const notify = require('./notify');
const mailer = require('./mailer');

const app = express();

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "cdnjs.cloudflare.com"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
    },
  },
}));

// Force HTTPS in production
app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production' && req.headers['x-forwarded-proto'] !== 'https') {
    return res.redirect(301, 'https://' + req.headers.host + req.url);
  }
  next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiting — global: 200 req/min per IP
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
});
app.use(globalLimiter);

// Strict limiter for auth endpoints — 10 attempts/min per IP
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts. Please wait a minute.' },
});

// Order endpoint limiter — 30/min per IP
const orderLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many orders. Please slow down.' },
});

const getCafe = (id) => db.prepare('SELECT * FROM cafes WHERE id = ?').get(id);

// Reset sold-out items daily at midnight
function scheduleDailySoldoutReset() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  setTimeout(() => {
    db.prepare('UPDATE menu_items SET available = 1 WHERE available = 0').run();
    console.log('[Daily reset] Sold-out items restored.');
    setInterval(() => {
      db.prepare('UPDATE menu_items SET available = 1 WHERE available = 0').run();
      console.log('[Daily reset] Sold-out items restored.');
    }, 24 * 60 * 60 * 1000);
  }, midnight - now);
}
scheduleDailySoldoutReset();

// Clean up expired reset tokens every hour
setInterval(() => {
  db.prepare("DELETE FROM password_resets WHERE created_at < datetime('now', '-1 hour')").run();
}, 60 * 60 * 1000);

// ===== AUTH =====

app.post('/api/auth/register', authLimiter, (req, res) => {
  const { cafe_name, email, password, upi_id } = req.body;
  if (!cafe_name || !email || !password) return res.status(400).json({ error: 'Missing fields' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email address' });
  if (db.prepare('SELECT 1 FROM owners WHERE email = ?').get(email))
    return res.status(409).json({ error: 'Email already registered' });

  const cafeId = 'cafe_' + Math.random().toString(36).slice(2, 8);
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO cafes (id,name,owner_email,upi_id) VALUES (?,?,?,?)')
      .run(cafeId, cafe_name.trim(), email, upi_id || null);
    const r = db.prepare('INSERT INTO owners (cafe_id,email,pass_hash) VALUES (?,?,?)')
      .run(cafeId, email, auth.hashPassword(password));
    return { id: r.lastInsertRowid, cafe_id: cafeId };
  });
  const owner = tx();
  const token = auth.createSession(owner);
  res.json({ ok: true, token, cafe_id: cafeId, cafe_name: cafe_name.trim() });
});

app.post('/api/auth/login', authLimiter, (req, res) => {
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

app.post('/api/auth/logout', auth.requireAuth, (req, res) => {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.json({ ok: true });
});

// Forgot password — request reset
app.post('/api/auth/forgot', authLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  const owner = db.prepare('SELECT * FROM owners WHERE email = ?').get(email);
  // Always return success to prevent email enumeration
  if (!owner) return res.json({ ok: true, message: 'If that email exists, a reset link has been sent.' });

  const crypto = require('crypto');
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('DELETE FROM password_resets WHERE owner_id = ?').run(owner.id);
  db.prepare('INSERT INTO password_resets (token, owner_id, email) VALUES (?,?,?)').run(token, owner.id, email);

  const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
  const resetUrl = `${baseUrl}/reset-password.html?token=${token}`;
  await mailer.sendResetEmail(email, resetUrl);
  res.json({ ok: true, message: 'If that email exists, a reset link has been sent.' });
});

// Reset password — use token
app.post('/api/auth/reset', authLimiter, (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Missing fields' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const reset = db.prepare(
    "SELECT * FROM password_resets WHERE token = ? AND created_at >= datetime('now', '-1 hour')"
  ).get(token);
  if (!reset) return res.status(400).json({ error: 'Reset link is invalid or has expired. Please request a new one.' });

  db.prepare('UPDATE owners SET pass_hash = ? WHERE id = ?').run(auth.hashPassword(password), reset.owner_id);
  db.prepare('DELETE FROM password_resets WHERE token = ?').run(token);
  db.prepare('DELETE FROM sessions WHERE owner_id = ?').run(reset.owner_id);
  res.json({ ok: true, message: 'Password updated. Please log in.' });
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

app.post('/api/order', orderLimiter, (req, res) => {
  const { cafe_id, seat_id, items, name, phone, pay_method } = req.body;
  const cafe = getCafe(cafe_id);
  if (!cafe) return res.status(404).json({ error: 'Cafe not found' });
  if (!items || !items.length) return res.status(400).json({ error: 'Cart is empty' });
  if (!phone) return res.status(400).json({ error: 'Phone required for receipt & loyalty' });
  if (!/^\d{10}$/.test(phone)) return res.status(400).json({ error: 'Enter a valid 10-digit phone number' });

  if (seat_id) {
    const activeCount = db.prepare(
      "SELECT COUNT(*) n FROM orders WHERE seat_id = ? AND status IN ('placed','preparing','ready') AND created_at >= datetime('now', '-2 hours')"
    ).get(seat_id);
    if (activeCount.n >= 3) return res.status(429).json({ error: 'Too many active orders from this seat. Please wait.' });
  }

  const seat = seat_id ? db.prepare('SELECT * FROM seats WHERE id = ?').get(seat_id) : null;

  let total = 0, eta = 0;
  const resolved = [];
  for (const line of items) {
    const m = db.prepare('SELECT * FROM menu_items WHERE id = ? AND cafe_id = ?').get(line.id, cafe_id);
    if (!m) return res.status(400).json({ error: `Item ${line.id} not on menu` });
    if (!m.available) return res.status(409).json({ error: `${m.name} is sold out` });
    const qty = Math.max(1, Math.min(20, parseInt(line.qty) || 1));
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

// Receipt endpoint — public, identified by order ID
app.get('/api/order/:id/receipt', (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  const items = db.prepare('SELECT name,qty,price FROM order_items WHERE order_id = ?').all(o.id);
  const cafe = getCafe(o.cafe_id);
  res.json({ order: o, items, cafe: { name: cafe.name, upi_id: cafe.upi_id } });
});

app.post('/api/order/:id/feedback', (req, res) => {
  const { rating, feedback } = req.body;
  if (rating && (rating < 1 || rating > 5)) return res.status(400).json({ error: 'Rating must be 1-5' });
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
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const offset = parseInt(req.query.offset) || 0;
  const orders = db.prepare(
    'SELECT * FROM orders WHERE cafe_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).all(req.params.cafeId, limit, offset);
  const getItems = db.prepare('SELECT name,qty,price FROM order_items WHERE order_id = ?');
  for (const o of orders) o.items = getItems.all(o.id);
  res.json(orders);
});

app.get('/api/cafe/:cafeId/history', auth.requireAuth, (req, res) => {
  const { from, to } = req.query;
  const fromDate = from || '2000-01-01';
  const toDate = to || '2099-12-31';
  const orders = db.prepare(
    `SELECT o.*, GROUP_CONCAT(oi.qty || 'x ' || oi.name, ', ') as items_summary
     FROM orders o LEFT JOIN order_items oi ON oi.order_id = o.id
     WHERE o.cafe_id = ? AND date(o.created_at) BETWEEN ? AND ?
     GROUP BY o.id ORDER BY o.created_at DESC`
  ).all(req.params.cafeId, fromDate, toDate);
  res.json(orders);
});

app.get('/api/cafe/:cafeId/export', auth.requireAuth, (req, res) => {
  const { from, to } = req.query;
  const fromDate = from || '2000-01-01';
  const toDate = to || '2099-12-31';
  const orders = db.prepare(
    `SELECT o.id, o.created_at, o.seat_label, o.status, o.total, o.paid, o.pay_method, o.rating,
            GROUP_CONCAT(oi.qty || 'x ' || oi.name, ' | ') as items
     FROM orders o LEFT JOIN order_items oi ON oi.order_id = o.id
     WHERE o.cafe_id = ? AND date(o.created_at) BETWEEN ? AND ?
     GROUP BY o.id ORDER BY o.created_at DESC`
  ).all(req.params.cafeId, fromDate, toDate);

  const header = 'Order ID,Date,Seat,Status,Total (Rs),Paid,Payment,Rating,Items\n';
  const rows = orders.map(o =>
    `${o.id},"${o.created_at}","${o.seat_label}",${o.status},${(o.total/100).toFixed(2)},${o.paid?'Yes':'No'},${o.pay_method},${o.rating||''},"${(o.items||'').replace(/"/g,'""')}"`
  ).join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="orders-${fromDate}-to-${toDate}.csv"`);
  res.send(header + rows);
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
  if (name.length > 100) return res.status(400).json({ error: 'Item name too long' });
  const r = db.prepare('INSERT INTO menu_items (cafe_id,name,price,category,prep_mins) VALUES (?,?,?,?,?)')
    .run(req.cafe_id, name.trim(), Math.round(price), (category || 'General').trim(), parseInt(prep_mins) || 10);
  res.json({ ok: true, id: r.lastInsertRowid });
});

app.post('/api/menu/:id', auth.requireAuth, (req, res) => {
  const m = db.prepare('SELECT cafe_id FROM menu_items WHERE id = ?').get(req.params.id);
  if (!m || m.cafe_id !== req.cafe_id) return res.status(403).json({ error: 'Not your item' });
  const { name, price, category, prep_mins } = req.body;
  if (!name || !(price >= 0)) return res.status(400).json({ error: 'Name and price required' });
  db.prepare('UPDATE menu_items SET name=?, price=?, category=?, prep_mins=? WHERE id=?')
    .run(name.trim(), Math.round(price), (category || 'General').trim(), parseInt(prep_mins) || 10, req.params.id);
  res.json({ ok: true });
});

app.post('/api/menu/:id/delete', auth.requireAuth, (req, res) => {
  const m = db.prepare('SELECT cafe_id FROM menu_items WHERE id = ?').get(req.params.id);
  if (!m || m.cafe_id !== req.cafe_id) return res.status(403).json({ error: 'Not your item' });
  db.prepare('DELETE FROM menu_items WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// Table management
app.get('/api/cafe/:cafeId/seats', auth.requireAuth, (req, res) => {
  res.json(db.prepare('SELECT id,label FROM seats WHERE cafe_id = ? ORDER BY label').all(req.params.cafeId));
});

app.post('/api/cafe/:cafeId/seats', auth.requireAuth, (req, res) => {
  const { label } = req.body;
  if (!label || !label.trim()) return res.status(400).json({ error: 'Table label required' });
  const cafeId = req.params.cafeId;
  const seatId = `${cafeId}_t${Date.now()}`;
  db.prepare('INSERT INTO seats (id, cafe_id, label) VALUES (?,?,?)').run(seatId, cafeId, label.trim());
  res.json({ ok: true, id: seatId, label: label.trim() });
});

app.post('/api/seats/:seatId/delete', auth.requireAuth, (req, res) => {
  const seat = db.prepare('SELECT * FROM seats WHERE id = ?').get(req.params.seatId);
  if (!seat || seat.cafe_id !== req.cafe_id) return res.status(403).json({ error: 'Not your table' });
  db.prepare('DELETE FROM seats WHERE id = ?').run(req.params.seatId);
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
  const week = db.prepare(`SELECT COALESCE(SUM(total),0) rev FROM orders WHERE cafe_id=? AND created_at >= datetime('now', '-7 days')`).get(c);
  const active = db.prepare(`SELECT COUNT(*) n FROM orders WHERE cafe_id=? AND status IN ('placed','preparing','ready')`).get(c);
  const avgRating = db.prepare(`SELECT ROUND(AVG(rating),1) r FROM orders WHERE cafe_id=? AND rating IS NOT NULL`).get(c);
  res.json({ orders_today: today.n, revenue_today: today.rev, revenue_week: week.rev, active_orders: active.n, avg_rating: avgRating.r || null });
});

app.get('/api/cafe/:cafeId/settings', auth.requireAuth, (req, res) => {
  const cafe = getCafe(req.params.cafeId);
  if (!cafe) return res.status(404).json({ error: 'Cafe not found' });
  res.json({ name: cafe.name, upi_id: cafe.upi_id, loyalty_rate: cafe.loyalty_rate });
});

app.post('/api/cafe/:cafeId/settings', auth.requireAuth, (req, res) => {
  const { name, upi_id, loyalty_rate } = req.body;
  if (!name) return res.status(400).json({ error: 'Cafe name required' });
  const rate = parseInt(loyalty_rate);
  if (isNaN(rate) || rate < 0 || rate > 100) return res.status(400).json({ error: 'Loyalty rate must be 0-100' });
  db.prepare('UPDATE cafes SET name=?, upi_id=?, loyalty_rate=? WHERE id=?')
    .run(name.trim(), upi_id || null, rate, req.params.cafeId);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ScanServe running: http://localhost:${PORT}`));
