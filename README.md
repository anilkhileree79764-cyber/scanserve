# ScanServe — Cafe Self-Ordering System

A complete, ready-to-sell web app that lets cafe customers **scan a QR code on their table, browse the menu, and place orders** — no app download needed. The cafe owner gets a live dashboard to manage orders, the menu, customers, and more.

---

## What it does

**For the customer (scans QR → orders in 30 seconds)**
- Scans QR code on table → menu loads instantly on their phone (with photos, veg/non-veg marks, spice level, bestseller tags)
- Searches the menu, adds items to cart with per-item notes (e.g. "no onion")
- "My usual" — repeat a previous order by phone number in one tap
- Enters phone number, places order; cart auto-saves and survives a dropped connection
- Sees a live countdown timer ("Your order is ready in 4 mins")
- Can call the waiter from their phone (water, bill, cutlery)
- Rates the experience after being served; happy customers are nudged to leave a Google review
- Earns loyalty points on every visit

**For the cafe owner (dashboard)**
- Live orders board — see every order as it comes in, with sound + desktop alerts
- Overdue alerts — orders that sit too long turn red and pulse; mark any order "rush"
- Kitchen display — big-text, dark-mode view for the cook, filterable by station (Kitchen / Bar)
- Menu editor — add/edit/delete items with photos, veg/non-veg, spice level, station; toggle sold-out instantly
- Sold-out items reset automatically every day at midnight
- Reports — daily closing report (cash vs UPI, profit = revenue − expenses), revenue chart, best/worst sellers, busiest-hours heatmap
- Expense tracking — log costs to see real daily profit
- Staff logins — add waiter/manager accounts (owner controls them)
- Customer list with loyalty points, visit history, and one-tap points redemption
- Win-back campaign — SMS/WhatsApp offer to customers inactive 30+ days
- Order history with date filter and CSV export; full data backup (JSON) anytime
- Cafe settings — name, UPI ID, loyalty rate, logo, brand colour, Google review link
- 14-day free trial that **actually locks** online ordering when it lapses (the paywall)
- Real subscription billing — ₹499/month via Razorpay (demo mode without keys); renew extends 30 days
- Upload menu photos straight from your phone (no image-host URL needed)
- Instant demo sandbox from the landing page (auto-cleaned daily)
- Onboarding tour for first-time owners; account deletion (delete all data)
- Email verification, automated daily DB backups, /healthz uptime endpoint
- Printable QR code sheet — one per table, print and stick

**Business model**
- Charge cafes ₹500–₹1,000/month
- Your hosting cost: ~$7/month total (not per cafe)
- Many cafes share one server — each cafe's data is completely separate

---

## How QR codes work

No special scanner hardware needed.

1. Owner logs in → clicks "Print QR codes" → prints the sheet
2. Sticks one QR label on each table
3. Customer points their phone camera at the QR → menu opens in the browser
4. Done — no app download, works on any smartphone

---

## Quick start (run on your computer)

**Requirements:** Node.js v22 or newer → [nodejs.org](https://nodejs.org)

```bash
git clone https://github.com/anilkhileree79764-cyber/scanserve
cd scanserve
npm install
npm run seed
npm start
```

Then open: http://localhost:3000

**Demo logins:**
| Role | Email | Password |
|------|-------|----------|
| Owner (Brew & Bean) | brew@demo.com | demo1234 |
| Owner (Chai Point) | chai@demo.com | demo1234 |

**Demo customer seat:** http://localhost:3000/order.html?seat=cafe_brewbean_t1

**On Windows:** just double-click `START-APP.bat`

---

## Project structure

```
server.js        — API + static file server
db.js            — SQLite database (Node built-in, no install needed)
auth.js          — Login, sessions (expire after 30 days), password hashing
payments.js      — Razorpay integration (demo mode until keys added)
notify.js        — SMS/WhatsApp via Twilio or webhook (demo mode by default)
seed.js          — Demo data (2 cafes, menus, seats)
public/
  index.html     — Landing page
  login.html     — Owner login & registration
  order.html     — Customer ordering page (opened by QR scan)
  dashboard.html — Owner dashboard
  qr.html        — Printable QR code sheet
START-APP.bat    — Windows one-click launcher
render.yaml      — Deploy config for Render.com
```

---

## Deploy to the internet (Render.com — free to start)

1. Push this repo to GitHub
2. Go to [render.com](https://render.com) → New → Web Service → connect your repo
3. Render reads `render.yaml` automatically — no config needed
4. Your app is live at `https://scanserve.onrender.com` (or your custom domain)

The database is stored on a persistent disk so orders are never lost between restarts.

---

## Environment variables (optional)

| Variable | Purpose |
|----------|---------|
| `PORT` | Port to run on (default: 3000) |
| `DB_PATH` | Path to SQLite file (default: `./cafe.db`) |
| `RZP_KEY_ID` + `RZP_KEY_SECRET` | Enable live Razorpay payments |
| `TWILIO_SID` + `TWILIO_TOKEN` + `TWILIO_FROM` | Enable real SMS via Twilio |
| `NOTIFY_WEBHOOK_URL` | Send SMS via any webhook instead |

Without these, the app runs in demo mode — fully functional for ordering and the dashboard, just no real payments or SMS.

---

## Tech stack

- **Backend:** Node.js + Express
- **Database:** SQLite via libSQL — a local `cafe.db` file for development, or a free durable **Turso** cloud database in production (set `TURSO_DATABASE_URL`)
- **Frontend:** Plain HTML/CSS/JS — no framework, loads instantly
- **Auth:** scrypt password hashing, bearer token sessions
- **Payments:** Razorpay (demo mode by default)
- **SMS:** Twilio or custom webhook (demo mode by default)

---

Built with ❤️ for Indian cafes.
