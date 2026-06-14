const SENT = [];

async function sendMessage(to, message) {
  if (process.env.TWILIO_SID && process.env.TWILIO_TOKEN && process.env.TWILIO_FROM) {
    const sid = process.env.TWILIO_SID;
    const auth = Buffer.from(`${sid}:${process.env.TWILIO_TOKEN}`).toString('base64');
    const body = new URLSearchParams({ To: to, From: process.env.TWILIO_FROM, Body: message });
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    SENT.push({ to, message, via: 'twilio', ok: r.ok, at: new Date().toISOString() });
    return r.ok;
  }
  if (process.env.NOTIFY_WEBHOOK_URL) {
    const r = await fetch(process.env.NOTIFY_WEBHOOK_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, message }),
    });
    SENT.push({ to, message, via: 'webhook', ok: r.ok, at: new Date().toISOString() });
    return r.ok;
  }
  console.log(`[DEMO SMS] -> ${to}: ${message}`);
  SENT.push({ to, message, via: 'demo', ok: true, at: new Date().toISOString() });
  return true;
}

module.exports = { sendMessage, SENT };
