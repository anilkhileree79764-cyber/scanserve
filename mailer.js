// mailer.js — sends ScanServe emails (password reset, email verify).
//
// Sending method, in order of preference:
//   1. Brevo HTTP API   — set BREVO_API_KEY (+ SMTP_FROM as the sender).
//      Uses HTTPS (port 443), so it works on free hosts that block SMTP ports.
//   2. SMTP             — set SMTP_HOST, SMTP_USER, SMTP_PASS (+ optional SMTP_PORT, SMTP_FROM).
//   3. Demo mode        — neither set: the link is logged to the server console.
const nodemailer = require('nodemailer');

const API_KEY = process.env.BREVO_API_KEY;
const FROM = process.env.SMTP_FROM || process.env.SMTP_USER;
const FROM_NAME = process.env.MAIL_FROM_NAME || 'ScanServe';

const HAS_SMTP = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
const MODE = API_KEY ? 'api' : (HAS_SMTP ? 'smtp' : 'demo');
const LIVE = MODE !== 'demo';

const transport = MODE === 'smtp'
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT) || 587,
      secure: parseInt(process.env.SMTP_PORT) === 465, // 465 = implicit TLS, 587 = STARTTLS
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      connectionTimeout: 10000,
    })
  : null;

// Send via Brevo's transactional email HTTP API (port 443 — never blocked).
async function sendViaApi(to, subject, html, text) {
  const r = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': API_KEY, 'content-type': 'application/json', 'accept': 'application/json' },
    body: JSON.stringify({
      sender: { email: FROM, name: FROM_NAME },
      to: [{ email: to }],
      subject, htmlContent: html, textContent: text,
    }),
  });
  if (!r.ok) throw new Error(`Brevo API ${r.status}: ${await r.text()}`);
  return true;
}

async function send(to, subject, html, text, demoTag, demoLink) {
  if (MODE === 'demo') {
    console.log(`\n[DEMO ${demoTag}] -> ${to}\nLink: ${demoLink}\n`);
    return true;
  }
  try {
    if (MODE === 'api') await sendViaApi(to, subject, html, text);
    else await transport.sendMail({ from: `"${FROM_NAME}" <${FROM}>`, to, subject, html, text });
    return true;
  } catch (e) {
    console.error('Email send failed:', e.message);
    return false;
  }
}

function sendResetEmail(email, resetUrl) {
  const html = `<p>Click the link below to reset your ScanServe password (valid for 1 hour):</p>
                <p><a href="${resetUrl}">${resetUrl}</a></p>
                <p>If you did not request this, you can ignore this email.</p>`;
  const text = `Reset your ScanServe password (valid for 1 hour):\n\n${resetUrl}\n\nIf you did not request this, ignore this email.`;
  return send(email, 'Reset your ScanServe password', html, text, 'PASSWORD RESET', resetUrl);
}

function sendVerifyEmail(email, verifyUrl) {
  const html = `<p>Welcome to ScanServe! Confirm your email address:</p><p><a href="${verifyUrl}">${verifyUrl}</a></p>`;
  const text = `Welcome to ScanServe! Confirm your email:\n\n${verifyUrl}`;
  return send(email, 'Verify your ScanServe email', html, text, 'EMAIL VERIFY', verifyUrl);
}

module.exports = { sendResetEmail, sendVerifyEmail, LIVE, MODE };
