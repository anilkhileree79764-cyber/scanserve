// mailer.js — sends password reset emails.
// Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS in env to go live.
// Without them, logs the reset link to console (demo mode).
const nodemailer = require('nodemailer');

const LIVE = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);

const transport = LIVE
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT) || 587,
      secure: false,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    })
  : null;

async function sendResetEmail(email, resetUrl) {
  if (!LIVE) {
    console.log(`\n[DEMO PASSWORD RESET] -> ${email}\nReset link: ${resetUrl}\n`);
    return true;
  }
  try {
    await transport.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: email,
      subject: 'Reset your ScanServe password',
      text: `Click the link below to reset your password (valid for 1 hour):\n\n${resetUrl}\n\nIf you did not request this, ignore this email.`,
      html: `<p>Click the link below to reset your password (valid for 1 hour):</p>
             <p><a href="${resetUrl}">${resetUrl}</a></p>
             <p>If you did not request this, ignore this email.</p>`,
    });
    return true;
  } catch (e) {
    console.error('Email send failed:', e.message);
    return false;
  }
}

async function sendVerifyEmail(email, verifyUrl) {
  if (!LIVE) {
    console.log(`\n[DEMO EMAIL VERIFY] -> ${email}\nVerify link: ${verifyUrl}\n`);
    return true;
  }
  try {
    await transport.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: email,
      subject: 'Verify your ScanServe email',
      text: `Welcome to ScanServe! Confirm your email:\n\n${verifyUrl}`,
      html: `<p>Welcome to ScanServe! Confirm your email:</p><p><a href="${verifyUrl}">${verifyUrl}</a></p>`,
    });
    return true;
  } catch (e) {
    console.error('Verify email failed:', e.message);
    return false;
  }
}

module.exports = { sendResetEmail, sendVerifyEmail, LIVE };
