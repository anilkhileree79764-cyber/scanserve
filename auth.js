const crypto = require('crypto');
const db = require('./db');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
}

function createSession(owner) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, owner_id, cafe_id) VALUES (?,?,?)')
    .run(token, owner.id, owner.cafe_id);
  return token;
}

function sessionFromReq(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return null;
  // Sessions expire after 30 days
  return db.prepare(
    "SELECT * FROM sessions WHERE token = ? AND created_at >= datetime('now', '-30 days')"
  ).get(token);
}

function requireAuth(req, res, next) {
  const s = sessionFromReq(req);
  if (!s) return res.status(401).json({ error: 'Login required' });
  const urlCafe = req.params.cafeId;
  if (urlCafe && urlCafe !== s.cafe_id) {
    return res.status(403).json({ error: 'Not your cafe' });
  }
  req.cafe_id = s.cafe_id;
  req.owner_id = s.owner_id;
  const o = db.prepare('SELECT email FROM owners WHERE id = ?').get(s.owner_id);
  req.owner_email = o ? o.email : (db.prepare('SELECT email FROM staff WHERE id = ?').get(s.owner_id)?.email || 'staff');
  next();
}

module.exports = { hashPassword, verifyPassword, createSession, sessionFromReq, requireAuth };
