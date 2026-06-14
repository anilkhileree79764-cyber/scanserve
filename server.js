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
      imgSrc: ["'self'", "data:", "https:"],
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

// Audit log helper — records owner actions for accountability
function audit(cafeId, actor, action, detail) {
  try { db.prepare('INSERT INTO audit_log (cafe_id,actor,action,detail) VALUES (?,?,?,?)')
    .run(cafeId, actor || 'owner', action, detail || null); } catch {}
}

// Health check (for uptime monitors / Render)
app.get('/healthz', (req, res) => {
  try { db.prepare('SELECT 1').get(); res.json({ ok: true, ts: Date.now() }); }
  catch (e) { res.status(500).json({ ok: false }); }
});

// Daily automated DB backup (keeps last 7)
function scheduleBackup() {
  const fs = require('fs');
  const dir = path.join(__dirname, 'backups');
  const run = () => {
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir);
      const src = process.env.DB_PATH || path.join(__dirname, 'cafe.db');
      if (fs.existsSync(src)) {
        const stamp = new Date().toISOString().slice(0, 10);
        fs.copyFileSync(src, path.join(dir, `cafe-${stamp}.db`));
        // prune to last 7
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.db')).sort();
        while (files.length > 7) fs.unlinkSync(path.join(dir, files.shift()));
        console.log('[Backup] saved cafe-' + stamp + '.db');
      }
    } catch (e) { console.error('[Backup] failed:', e.message); }
  };
  run();
  setInterval(run, 24 * 60 * 60 * 1000);
}
scheduleBackup();

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

  const crypto = require('crypto');
  const cafeId = 'cafe_' + Math.random().toString(36).slice(2, 8);
  const verifyToken = crypto.randomBytes(24).toString('hex');
  const tx = db.transaction(() => {
    db.prepare("INSERT INTO cafes (id,name,owner_email,upi_id,trial_ends) VALUES (?,?,?,?,datetime('now','+14 days'))")
      .run(cafeId, cafe_name.trim(), email, upi_id || null);
    const r = db.prepare('INSERT INTO owners (cafe_id,email,pass_hash,verify_token) VALUES (?,?,?,?)')
      .run(cafeId, email, auth.hashPassword(password), verifyToken);
    return { id: r.lastInsertRowid, cafe_id: cafeId };
  });
  const owner = tx();
  seedStarterData(cafeId);

  // Send verification email (demo mode logs link to console)
  const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
  mailer.sendVerifyEmail(email, `${baseUrl}/api/auth/verify?token=${verifyToken}`).catch(() => {});

  const token = auth.createSession(owner);
  res.json({ ok: true, token, cafe_id: cafeId, cafe_name: cafe_name.trim(), is_new: true });
});

// Seed a starter menu + tables so new owners don't see an empty dashboard
function seedStarterData(cafeId) {
  const starterMenu = [
    // name, price(paise), category, prep, food_type, spicy, station, desc
    ['Cappuccino', 8000, 'Coffee', 5, 'veg', 0, 'Bar', 'Rich espresso with steamed milk foam'],
    ['Masala Chai', 3000, 'Tea', 4, 'veg', 1, 'Bar', 'Spiced Indian tea'],
    ['Cold Coffee', 10000, 'Coffee', 5, 'veg', 0, 'Bar', 'Chilled blended coffee'],
    ['Veg Sandwich', 8000, 'Food', 8, 'veg', 0, 'Kitchen', 'Grilled veggies & cheese'],
    ['Paneer Tikka', 16000, 'Food', 12, 'veg', 2, 'Kitchen', 'Smoky grilled cottage cheese'],
    ['Chicken Roll', 14000, 'Food', 10, 'nonveg', 1, 'Kitchen', 'Spiced chicken wrap'],
    ['Chocolate Brownie', 6000, 'Desserts', 2, 'egg', 0, 'Kitchen', 'Warm fudgy brownie'],
  ];
  const insItem = db.prepare('INSERT INTO menu_items (cafe_id,name,price,category,prep_mins,food_type,spicy,station,description) VALUES (?,?,?,?,?,?,?,?,?)');
  for (const m of starterMenu) insItem.run(cafeId, ...m);
  for (let i = 1; i <= 4; i++) {
    db.prepare('INSERT INTO seats (id, cafe_id, label) VALUES (?,?,?)').run(`${cafeId}_t${i}`, cafeId, `Table ${i}`);
  }
}

// Verify email link
app.get('/api/auth/verify', (req, res) => {
  const owner = db.prepare('SELECT * FROM owners WHERE verify_token = ?').get(req.query.token);
  if (!owner) return res.status(400).send('<h2>Invalid or expired verification link.</h2>');
  db.prepare('UPDATE owners SET email_verified=1, verify_token=NULL WHERE id=?').run(owner.id);
  res.send('<h2 style="font-family:system-ui">✅ Email verified! You can close this tab.</h2>');
});

app.post('/api/auth/login', authLimiter, (req, res) => {
  const { email, password } = req.body;
  let owner = db.prepare('SELECT * FROM owners WHERE email = ?').get(email);
  let role = 'owner';
  if (!owner) {
    const st = db.prepare('SELECT * FROM staff WHERE email = ?').get(email);
    if (st) { owner = st; role = st.role; }
  }
  if (!owner || !auth.verifyPassword(password, owner.pass_hash))
    return res.status(401).json({ error: 'Wrong email or password' });
  const token = auth.createSession(owner);
  const cafe = getCafe(owner.cafe_id);
  res.json({ ok: true, token, cafe_id: owner.cafe_id, cafe_name: cafe.name, role });
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
    `SELECT id,name,price,category,prep_mins,available,image_url,food_type,spicy,is_combo,description
     FROM menu_items WHERE cafe_id = ? ORDER BY category,name`
  ).all(seat.cafe_id);
  // Bestseller flags — top 3 most-ordered items in last 30 days
  const best = db.prepare(
    `SELECT oi.item_id id, SUM(oi.qty) n FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
      WHERE o.cafe_id = ? AND o.created_at >= datetime('now','-30 days')
      GROUP BY oi.item_id ORDER BY n DESC LIMIT 3`
  ).all(seat.cafe_id);
  const bestIds = new Set(best.map(b => b.id));
  for (const m of menu) m.bestseller = bestIds.has(m.id) ? 1 : 0;
  res.json({
    cafe: { id: cafe.id, name: cafe.name, upi_id: cafe.upi_id,
            logo_url: cafe.logo_url, brand_color: cafe.brand_color || '#b5651d' },
    seat, menu,
  });
});

// Repeat last order — by phone
app.get('/api/scan/:seatId/last-order', (req, res) => {
  const seat = db.prepare('SELECT * FROM seats WHERE id = ?').get(req.params.seatId);
  if (!seat) return res.status(404).json({ error: 'Unknown QR code' });
  const phone = (req.query.phone || '').toString();
  if (!/^\d{10}$/.test(phone)) return res.status(400).json({ error: 'Valid phone required' });
  const cust = db.prepare('SELECT id FROM customers WHERE cafe_id=? AND phone=?').get(seat.cafe_id, phone);
  if (!cust) return res.json({ items: [] });
  const last = db.prepare('SELECT id FROM orders WHERE cafe_id=? AND customer_id=? ORDER BY created_at DESC LIMIT 1')
    .get(seat.cafe_id, cust.id);
  if (!last) return res.json({ items: [] });
  const items = db.prepare('SELECT item_id id, name, qty FROM order_items WHERE order_id=?').all(last.id);
  res.json({ items });
});

// Call waiter (public)
app.post('/api/call-waiter', orderLimiter, (req, res) => {
  const { seat_id, reason } = req.body;
  const seat = seat_id ? db.prepare('SELECT * FROM seats WHERE id = ?').get(seat_id) : null;
  if (!seat) return res.status(404).json({ error: 'Unknown table' });
  // throttle: max 1 unresolved call per seat per 2 min
  const recent = db.prepare(
    "SELECT 1 FROM waiter_calls WHERE seat_id=? AND resolved=0 AND created_at >= datetime('now','-2 minutes')"
  ).get(seat_id);
  if (recent) return res.json({ ok: true, message: 'Staff already notified' });
  db.prepare('INSERT INTO waiter_calls (cafe_id,seat_id,seat_label,reason) VALUES (?,?,?,?)')
    .run(seat.cafe_id, seat_id, seat.label, (reason || 'Assistance').toString().slice(0, 80));
  res.json({ ok: true, message: 'Staff notified' });
});

app.post('/api/order', orderLimiter, (req, res) => {
  const { cafe_id, seat_id, items, name, phone, pay_method, notes } = req.body;
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
    resolved.push({ id: m.id, name: m.name, price: m.price, qty, note: (line.note || '').toString().slice(0, 120) || null });
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
      `INSERT INTO orders (cafe_id,seat_id,seat_label,customer_id,total,pay_method,eta_mins,notes)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(cafe_id, seat_id || null, seat ? seat.label : 'Takeaway', cust.id, total, pay_method || 'upi', eta, notes || null);
    const insItem = db.prepare('INSERT INTO order_items (order_id,item_id,name,price,qty,note) VALUES (?,?,?,?,?,?)');
    for (const it of resolved) insItem.run(o.lastInsertRowid, it.id, it.name, it.price, it.qty, it.note);
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
  const items = db.prepare('SELECT name,qty,price,note FROM order_items WHERE order_id = ?').all(o.id);
  const cafe = getCafe(o.cafe_id);
  res.json({ order: o, items, cafe: { name: cafe.name, upi_id: cafe.upi_id, google_review_url: cafe.google_review_url } });
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
  const getItems = db.prepare('SELECT name,qty,price,note,item_id FROM order_items WHERE order_id = ?');
  for (const o of orders) {
    o.items = getItems.all(o.id);
    // attach station(s) for kitchen routing
    const st = db.prepare(
      `SELECT DISTINCT m.station FROM order_items oi JOIN menu_items m ON m.id=oi.item_id WHERE oi.order_id=?`
    ).all(o.id).map(r => r.station).filter(Boolean);
    o.stations = st.length ? st : ['Kitchen'];
  }
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

const FOOD_TYPES = ['veg', 'nonveg', 'egg'];
app.post('/api/cafe/:cafeId/menu', auth.requireAuth, (req, res) => {
  const { name, price, category, prep_mins, image_url, food_type, spicy, is_combo, station, description } = req.body;
  if (!name || !(price >= 0)) return res.status(400).json({ error: 'Name and price required' });
  if (name.length > 100) return res.status(400).json({ error: 'Item name too long' });
  const ft = FOOD_TYPES.includes(food_type) ? food_type : 'veg';
  const r = db.prepare(
    `INSERT INTO menu_items (cafe_id,name,price,category,prep_mins,image_url,food_type,spicy,is_combo,station,description)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(req.cafe_id, name.trim(), Math.round(price), (category || 'General').trim(), parseInt(prep_mins) || 10,
        (image_url || '').toString().slice(0, 500) || null, ft, Math.max(0, Math.min(3, parseInt(spicy) || 0)),
        is_combo ? 1 : 0, (station || 'Kitchen').toString().slice(0, 40), (description || '').toString().slice(0, 200) || null);
  audit(req.cafe_id, req.owner_email, 'menu.add', name);
  res.json({ ok: true, id: r.lastInsertRowid });
});

app.post('/api/menu/:id', auth.requireAuth, (req, res) => {
  const m = db.prepare('SELECT cafe_id FROM menu_items WHERE id = ?').get(req.params.id);
  if (!m || m.cafe_id !== req.cafe_id) return res.status(403).json({ error: 'Not your item' });
  const { name, price, category, prep_mins, image_url, food_type, spicy, is_combo, station, description } = req.body;
  if (!name || !(price >= 0)) return res.status(400).json({ error: 'Name and price required' });
  const ft = FOOD_TYPES.includes(food_type) ? food_type : 'veg';
  db.prepare(
    `UPDATE menu_items SET name=?, price=?, category=?, prep_mins=?, image_url=?, food_type=?, spicy=?, is_combo=?, station=?, description=? WHERE id=?`
  ).run(name.trim(), Math.round(price), (category || 'General').trim(), parseInt(prep_mins) || 10,
        (image_url || '').toString().slice(0, 500) || null, ft, Math.max(0, Math.min(3, parseInt(spicy) || 0)),
        is_combo ? 1 : 0, (station || 'Kitchen').toString().slice(0, 40), (description || '').toString().slice(0, 200) || null,
        req.params.id);
  audit(req.cafe_id, req.owner_email, 'menu.edit', name);
  res.json({ ok: true });
});

// Toggle order priority (rush flag)
app.post('/api/order/:id/priority', auth.requireAuth, (req, res) => {
  const o = db.prepare('SELECT cafe_id FROM orders WHERE id = ?').get(req.params.id);
  if (!o || o.cafe_id !== req.cafe_id) return res.status(403).json({ error: 'Not your order' });
  db.prepare('UPDATE orders SET priority=? WHERE id=?').run(req.body.priority ? 1 : 0, req.params.id);
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
  res.json({ name: cafe.name, upi_id: cafe.upi_id, loyalty_rate: cafe.loyalty_rate,
             logo_url: cafe.logo_url, brand_color: cafe.brand_color || '#b5651d',
             google_review_url: cafe.google_review_url });
});

app.post('/api/cafe/:cafeId/settings', auth.requireAuth, (req, res) => {
  const { name, upi_id, loyalty_rate, logo_url, brand_color, google_review_url } = req.body;
  if (!name) return res.status(400).json({ error: 'Cafe name required' });
  const rate = parseInt(loyalty_rate);
  if (isNaN(rate) || rate < 0 || rate > 100) return res.status(400).json({ error: 'Loyalty rate must be 0-100' });
  const color = /^#[0-9a-fA-F]{6}$/.test(brand_color || '') ? brand_color : '#b5651d';
  db.prepare('UPDATE cafes SET name=?, upi_id=?, loyalty_rate=?, logo_url=?, brand_color=?, google_review_url=? WHERE id=?')
    .run(name.trim(), upi_id || null, rate, (logo_url || '').toString().slice(0, 500) || null, color,
         (google_review_url || '').toString().slice(0, 500) || null, req.params.cafeId);
  audit(req.cafe_id, req.owner_email, 'settings.update', null);
  res.json({ ok: true });
});

// ===== TRIAL / PLAN =====
app.get('/api/cafe/:cafeId/trial', auth.requireAuth, (req, res) => {
  const cafe = getCafe(req.params.cafeId);
  let daysLeft = null;
  if (cafe.trial_ends) {
    const ms = new Date(cafe.trial_ends + 'Z').getTime() - Date.now();
    daysLeft = Math.ceil(ms / 86400000);
  }
  res.json({ plan: cafe.plan, trial_ends: cafe.trial_ends, days_left: daysLeft, expired: cafe.plan === 'free' && daysLeft !== null && daysLeft <= 0 });
});

// ===== WAITER CALLS (owner) =====
app.get('/api/cafe/:cafeId/waiter-calls', auth.requireAuth, (req, res) => {
  res.json(db.prepare("SELECT * FROM waiter_calls WHERE cafe_id=? AND resolved=0 ORDER BY created_at DESC").all(req.params.cafeId));
});
app.post('/api/waiter-calls/:id/resolve', auth.requireAuth, (req, res) => {
  const c = db.prepare('SELECT cafe_id FROM waiter_calls WHERE id=?').get(req.params.id);
  if (!c || c.cafe_id !== req.cafe_id) return res.status(403).json({ error: 'Not yours' });
  db.prepare('UPDATE waiter_calls SET resolved=1 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ===== REPORTS / ANALYTICS =====
// Daily closing report
app.get('/api/cafe/:cafeId/report', auth.requireAuth, (req, res) => {
  const c = req.params.cafeId;
  const day = req.query.date || null; // YYYY-MM-DD; default today
  const dateExpr = day ? "date(created_at)=?" : "date(created_at)=date('now')";
  const args = day ? [c, day] : [c];
  const sum = db.prepare(`SELECT COUNT(*) orders, COALESCE(SUM(total),0) revenue,
      COALESCE(SUM(CASE WHEN pay_method='cash' THEN total ELSE 0 END),0) cash,
      COALESCE(SUM(CASE WHEN pay_method!='cash' THEN total ELSE 0 END),0) upi
      FROM orders WHERE cafe_id=? AND ${dateExpr}`).get(...args);
  const top = db.prepare(`SELECT oi.name, SUM(oi.qty) qty, SUM(oi.qty*oi.price) revenue
      FROM order_items oi JOIN orders o ON o.id=oi.order_id
      WHERE o.cafe_id=? AND ${dateExpr.replace('created_at','o.created_at')}
      GROUP BY oi.name ORDER BY qty DESC LIMIT 5`).all(...args);
  const exp = db.prepare(`SELECT COALESCE(SUM(amount),0) total FROM expenses WHERE cafe_id=? AND ${day ? 'spent_on=?' : "spent_on=date('now')"}`).get(...args);
  res.json({ date: day || 'today', ...sum, expenses: exp.total, profit: sum.revenue - exp.total, top_items: top });
});

// Revenue series (last N days) for charts
app.get('/api/cafe/:cafeId/series', auth.requireAuth, (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 14, 90);
  const rows = db.prepare(
    `SELECT date(created_at) d, COUNT(*) orders, COALESCE(SUM(total),0) revenue
     FROM orders WHERE cafe_id=? AND created_at >= datetime('now', ?)
     GROUP BY date(created_at) ORDER BY d`
  ).all(req.params.cafeId, `-${days} days`);
  res.json(rows);
});

// Best & worst sellers
app.get('/api/cafe/:cafeId/sellers', auth.requireAuth, (req, res) => {
  const rows = db.prepare(
    `SELECT m.id, m.name, COALESCE(SUM(oi.qty),0) qty, COALESCE(SUM(oi.qty*oi.price),0) revenue
     FROM menu_items m LEFT JOIN order_items oi ON oi.item_id=m.id
       LEFT JOIN orders o ON o.id=oi.order_id AND o.created_at >= datetime('now','-30 days')
     WHERE m.cafe_id=? GROUP BY m.id ORDER BY qty DESC`
  ).all(req.params.cafeId);
  res.json({ best: rows.slice(0, 5), worst: rows.filter(r => r.qty === 0).slice(0, 10), all: rows });
});

// Peak hours heatmap (orders by hour of day, last 30 days)
app.get('/api/cafe/:cafeId/peak-hours', auth.requireAuth, (req, res) => {
  const rows = db.prepare(
    `SELECT CAST(strftime('%H', created_at, 'localtime') AS INTEGER) hour, COUNT(*) orders
     FROM orders WHERE cafe_id=? AND created_at >= datetime('now','-30 days')
     GROUP BY hour ORDER BY hour`
  ).all(req.params.cafeId);
  const map = Array.from({ length: 24 }, (_, h) => ({ hour: h, orders: 0 }));
  for (const r of rows) if (map[r.hour]) map[r.hour].orders = r.orders;
  res.json(map);
});

// ===== STAFF (owner only) =====
app.get('/api/cafe/:cafeId/staff', auth.requireAuth, (req, res) => {
  res.json(db.prepare('SELECT id,name,email,role,created_at FROM staff WHERE cafe_id=? ORDER BY created_at').all(req.params.cafeId));
});
app.post('/api/cafe/:cafeId/staff', auth.requireAuth, (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email' });
  if (db.prepare('SELECT 1 FROM owners WHERE email=?').get(email) || db.prepare('SELECT 1 FROM staff WHERE email=?').get(email))
    return res.status(409).json({ error: 'Email already in use' });
  const r = db.prepare('INSERT INTO staff (cafe_id,name,email,pass_hash,role) VALUES (?,?,?,?,?)')
    .run(req.cafe_id, name.trim(), email, auth.hashPassword(password), ['waiter','manager'].includes(role) ? role : 'waiter');
  audit(req.cafe_id, req.owner_email, 'staff.add', email);
  res.json({ ok: true, id: r.lastInsertRowid });
});
app.post('/api/staff/:id/delete', auth.requireAuth, (req, res) => {
  const s = db.prepare('SELECT cafe_id,email FROM staff WHERE id=?').get(req.params.id);
  if (!s || s.cafe_id !== req.cafe_id) return res.status(403).json({ error: 'Not yours' });
  db.prepare('DELETE FROM staff WHERE id=?').run(req.params.id);
  audit(req.cafe_id, req.owner_email, 'staff.remove', s.email);
  res.json({ ok: true });
});

// ===== EXPENSES =====
app.get('/api/cafe/:cafeId/expenses', auth.requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM expenses WHERE cafe_id=? ORDER BY spent_on DESC, id DESC LIMIT 200').all(req.params.cafeId));
});
app.post('/api/cafe/:cafeId/expenses', auth.requireAuth, (req, res) => {
  const { label, amount, category, spent_on } = req.body;
  if (!label || !(amount > 0)) return res.status(400).json({ error: 'Label and amount required' });
  const r = db.prepare('INSERT INTO expenses (cafe_id,label,amount,category,spent_on) VALUES (?,?,?,?,?)')
    .run(req.cafe_id, label.trim().slice(0, 80), Math.round(amount), (category || 'General').slice(0, 40), spent_on || new Date().toISOString().slice(0, 10));
  res.json({ ok: true, id: r.lastInsertRowid });
});
app.post('/api/expenses/:id/delete', auth.requireAuth, (req, res) => {
  const e = db.prepare('SELECT cafe_id FROM expenses WHERE id=?').get(req.params.id);
  if (!e || e.cafe_id !== req.cafe_id) return res.status(403).json({ error: 'Not yours' });
  db.prepare('DELETE FROM expenses WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ===== LOYALTY REDEMPTION =====
app.post('/api/cafe/:cafeId/redeem', auth.requireAuth, (req, res) => {
  const { phone, points } = req.body;
  const cust = db.prepare('SELECT * FROM customers WHERE cafe_id=? AND phone=?').get(req.params.cafeId, phone);
  if (!cust) return res.status(404).json({ error: 'Customer not found' });
  const p = parseInt(points);
  if (!(p > 0) || p > cust.points) return res.status(400).json({ error: `Customer has only ${cust.points} points` });
  db.prepare('UPDATE customers SET points=points-?, redeemed=redeemed+? WHERE id=?').run(p, p, cust.id);
  audit(req.cafe_id, req.owner_email, 'loyalty.redeem', `${phone}:${p}pts`);
  res.json({ ok: true, remaining: cust.points - p, rupees_off: (p / 100).toFixed(2) });
});

// ===== AUDIT LOG (owner) =====
app.get('/api/cafe/:cafeId/audit', auth.requireAuth, (req, res) => {
  res.json(db.prepare('SELECT actor,action,detail,created_at FROM audit_log WHERE cafe_id=? ORDER BY id DESC LIMIT 100').all(req.params.cafeId));
});

// ===== FULL DATA EXPORT (backup) =====
app.get('/api/cafe/:cafeId/backup', auth.requireAuth, (req, res) => {
  const c = req.params.cafeId;
  const dump = {
    exported_at: new Date().toISOString(),
    cafe: getCafe(c),
    menu: db.prepare('SELECT * FROM menu_items WHERE cafe_id=?').all(c),
    seats: db.prepare('SELECT * FROM seats WHERE cafe_id=?').all(c),
    customers: db.prepare('SELECT * FROM customers WHERE cafe_id=?').all(c),
    orders: db.prepare('SELECT * FROM orders WHERE cafe_id=?').all(c),
    order_items: db.prepare('SELECT oi.* FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.cafe_id=?').all(c),
    expenses: db.prepare('SELECT * FROM expenses WHERE cafe_id=?').all(c),
    staff: db.prepare('SELECT id,name,email,role FROM staff WHERE cafe_id=?').all(c),
  };
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="scanserve-backup-${c}.json"`);
  res.send(JSON.stringify(dump, null, 2));
});

// ===== ACCOUNT DELETION (GDPR-style) =====
app.post('/api/cafe/:cafeId/delete-account', auth.requireAuth, (req, res) => {
  const c = req.params.cafeId;
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE cafe_id=?)').run(c);
    for (const t of ['orders', 'customers', 'menu_items', 'seats', 'expenses', 'staff', 'waiter_calls', 'audit_log', 'sessions', 'owners', 'cafes']) {
      const col = t === 'cafes' ? 'id' : 'cafe_id';
      try { db.prepare(`DELETE FROM ${t} WHERE ${col}=?`).run(c); } catch {}
    }
  });
  tx();
  res.json({ ok: true, message: 'Account and all data permanently deleted.' });
});

// ===== DEMO SANDBOX =====
app.post('/api/demo', authLimiter, (req, res) => {
  const crypto = require('crypto');
  const cafeId = 'demo_' + crypto.randomBytes(3).toString('hex');
  const email = `demo_${cafeId}@scanserve.app`;
  const tx = db.transaction(() => {
    db.prepare("INSERT INTO cafes (id,name,owner_email,upi_id,trial_ends) VALUES (?,?,?,?,datetime('now','+14 days'))")
      .run(cafeId, 'Demo Cafe', email, 'democafe@upi');
    const r = db.prepare('INSERT INTO owners (cafe_id,email,pass_hash,email_verified) VALUES (?,?,?,1)')
      .run(cafeId, email, auth.hashPassword(crypto.randomBytes(8).toString('hex')));
    return { id: r.lastInsertRowid, cafe_id: cafeId };
  });
  const owner = tx();
  seedStarterData(cafeId);
  // a couple of sample completed orders so charts/reports aren't empty
  const seats = db.prepare('SELECT id,label FROM seats WHERE cafe_id=?').all(cafeId);
  const items = db.prepare('SELECT * FROM menu_items WHERE cafe_id=?').all(cafeId);
  for (let i = 0; i < 6; i++) {
    const it = items[i % items.length];
    const o = db.prepare("INSERT INTO orders (cafe_id,seat_id,seat_label,status,total,pay_method,paid,created_at) VALUES (?,?,?,?,?,?,1,datetime('now',?))")
      .run(cafeId, seats[i % seats.length].id, seats[i % seats.length].label, 'served', it.price, i % 2 ? 'cash' : 'upi', `-${i} days`);
    db.prepare('INSERT INTO order_items (order_id,item_id,name,price,qty) VALUES (?,?,?,?,1)').run(o.lastInsertRowid, it.id, it.name, it.price);
  }
  const token = auth.createSession(owner);
  res.json({ ok: true, token, cafe_id: cafeId, cafe_name: 'Demo Cafe', is_new: false, demo: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ScanServe running: http://localhost:${PORT}`));
