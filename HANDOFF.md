# ScanServe — project status & handoff

Read this first to continue work in a new chat.

## What it is
ScanServe — a QR-code self-ordering web app sold to cafes (multi-tenant SaaS).
Owner/seller: Anil (`anilkhileree79764@gmail.com`, GitHub `anilkhileree79764-cyber`).

## Live
- App: https://scanserve.onrender.com
- Owner admin (Anil only): https://scanserve.onrender.com/admin.html
- Repo: https://github.com/anilkhileree79764-cyber/scanserve  (branch `main`, auto-deploys on push)
- Health: https://scanserve.onrender.com/healthz

## Hosting / infra (all FREE)
- **Render** free web service `scanserve` (service id `srv-d8o5k4mgvqtc73fuudi0`).
  Free tier sleeps after ~15 min idle → first hit takes ~30–50s (data is safe).
- **Turso** free cloud DB (org `anilkhileree`, db `scanserve`, Mumbai). The app uses
  libSQL; `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` are set in Render env.
- **Brevo** for email (HTTP API). `BREVO_API_KEY` + `SMTP_FROM` set in Render.
- Render env also has `BASE_URL`, `NODE_ENV=production`.

## Tech
Node + Express, libSQL/Turso DB, plain HTML/CSS/JS frontend. `npm test` runs a
12-test smoke suite (boots server on a temp DB). Run it before pushing.

## Done
- Full ordering flow (menu w/ photos, veg/spice/bestseller tags, item notes),
  kitchen view, live orders, reports/charts, expenses, staff logins, loyalty,
  win-back, history/CSV, settings, branding.
- Bulk-create tables; QR page (/qr.html) makes downloadable stickers with the
  table number printed on each.
- 14-day trial that ENFORCES a paywall (expired free cafe → HTTP 402 on order).
- Rating only after order is "served"; order notification sound (unlock on click).
- Account deletion, daily DB backup, audit log, demo-cafe auto-cleanup.
- CSP fix so inline onclick handlers work (was silently breaking all buttons).
- **Direct UPI subscription payments** (no Razorpay): cafe "Subscribe ₹499"
  opens a UPI deep link to the owner's UPI + a QR; owner confirms in /admin.html.

## PENDING (next steps)
1. **Set the receiving UPI**: Anil opens `/admin.html`, creates an admin password
   (first run), and enters his UPI ID (e.g. `<number>@ybl`). Until then, the cafe
   "Subscribe" button says "not set up yet". Test: a cafe taps Subscribe → UPI app
   opens prefilled → pays → taps "I've paid" → Anil clicks "Mark paid (30 days)".
2. **Brevo email activation**: integration is correct, but Brevo hadn't yet
   activated the new account for sending (returns 403 "account not yet activated").
   This is Brevo's manual anti-spam review (hours–1 day). To verify later: POST
   `/api/auth/forgot` and check Render logs for "Email send failed" vs success.
   If still blocked, email contact@brevo.com to request activation.
3. (Optional) When a real cafe pays, switch Render `plan: free` → `starter` ($7)
   in render.yaml to remove the cold-start. No data migration (data is in Turso).

## Secrets note
The original Turso token was pasted in an old chat and then INVALIDATED; a new one
is in Render. Don't reuse anything from chat history.

## To resume in a new chat
Say: "Continue my ScanServe project — read HANDOFF.md in the scanserve repo at
C:\Users\anilk\scanserve". I (Claude) will read this file and pick up.
