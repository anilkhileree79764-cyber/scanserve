const crypto = require('crypto');

const KEY_ID = process.env.RZP_KEY_ID || '';
const KEY_SECRET = process.env.RZP_KEY_SECRET || '';
const LIVE = !!(KEY_ID && KEY_SECRET);

async function createOrder(amountPaise, receipt) {
  if (!LIVE) {
    return { demo: true, key_id: 'demo', order_id: 'order_demo_' + Date.now(), amount: amountPaise };
  }
  const auth = Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64');
  const r = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
    body: JSON.stringify({ amount: amountPaise, currency: 'INR', receipt }),
  });
  if (!r.ok) throw new Error('Razorpay order failed: ' + (await r.text()));
  const o = await r.json();
  return { demo: false, key_id: KEY_ID, order_id: o.id, amount: o.amount };
}

function verifySignature(orderId, paymentId, signature) {
  if (!LIVE) return true;
  const expected = crypto.createHmac('sha256', KEY_SECRET)
    .update(`${orderId}|${paymentId}`).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature || ''));
}

module.exports = { createOrder, verifySignature, LIVE, KEY_ID };
