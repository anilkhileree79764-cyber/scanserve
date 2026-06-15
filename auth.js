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

async function createSession(owner, actorKind = 'owner') {
  const token = crypto.randomBytes(32).toString('hex');
  await db.prepare('INSERT INTO sessions (token, owner_id, cafe_id, actor_kind) VALUES (?,?,?,?)')
    .run(token, owner.id, owner.cafe_id, actorKind);
  return token;
}

async function sessionFromReq(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return null;
  // Sessions expire after 30 days
  return db.prepare(
    "SELECT * FROM sessions WHERE token = ? AND created_at >= datetime('now', '-30 days')"
  ).get(token);
}

async function requireAuth(req, res, next) {
  try {
    const s = await sessionFromReq(req);
    if (!s) return res.status(401).json({ error: 'Login required' });
    const urlCafe = req.params.cafeId;
    if (urlCafe && urlCafe !== s.cafe_id) {
      return res.status(403).json({ error: 'Not your cafe' });
    }
    req.cafe_id = s.cafe_id;
    req.owner_id = s.owner_id;
    req.actor_kind = s.actor_kind || 'owner';
    // Resolve the acting user's email from the correct table (owner vs staff)
    const table = req.actor_kind === 'owner' ? 'owners' : 'staff';
    const rec = await db.prepare(`SELECT email FROM ${table} WHERE id = ? AND cafe_id = ?`).get(s.owner_id, s.cafe_id);
    req.owner_email = rec ? rec.email : req.actor_kind;
    next();
  } catch (e) { next(e); }
}

// Guard: only the cafe owner (not waiter/manager staff) may perform this action
function requireOwner(req, res, next) {
  if (req.actor_kind !== 'owner') return res.status(403).json({ error: 'Only the cafe owner can do this.' });
  next();
}

module.exports = { hashPassword, verifyPassword, createSession, sessionFromReq, requireAuth, requireOwner };
