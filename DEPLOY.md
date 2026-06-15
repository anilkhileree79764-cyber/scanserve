# Deploying ScanServe — FREE and durable

This setup costs **₹0 / month** and your data is **permanent** (so a cafe can
trial it on real customers for days). It uses:

- **Turso** — a free cloud database (your data lives here, never lost)
- **Render** — a free server to run the app

You'll create two free accounts. Neither needs a credit card.

---

## 1. Create the free database (Turso)

1. Go to **https://turso.tech** and sign up (GitHub login is easiest).
2. Create a database (any name, e.g. `scanserve`). Pick the region closest to
   you (e.g. Bangalore / Mumbai).
3. You need two values — the dashboard shows them, or use the Turso CLI:
   - **Database URL** — looks like `libsql://scanserve-yourname.turso.io`
   - **Auth token** — a long secret string
   Keep these for step 3.

## 2. Create the free server (Render)

1. Go to **https://render.com** → **Get Started** → **Sign in with GitHub**,
   and authorize Render for the `anilkhileree79764-cyber` account.
   (You have to do this part yourself — account creation and the GitHub
   authorization can't be automated.)
2. Click **New +** → **Blueprint** → pick the **`scanserve`** repo → **Apply**.
   Render reads `render.yaml` and proposes the free `scanserve` web service.

## 3. Connect them (environment variables)

In the Render service's **Environment** tab, add:

| Key | Value |
|-----|-------|
| `TURSO_DATABASE_URL` | the `libsql://...` URL from step 1 |
| `TURSO_AUTH_TOKEN` | the auth token from step 1 |
| `BASE_URL` | your live URL once you know it, e.g. `https://scanserve.onrender.com` |

Leave the Razorpay / SMTP keys empty for now — billing and email run in demo
mode until you add them. Click **Save** and Render redeploys.

## 4. You're live

You'll get a URL like `https://scanserve.onrender.com`.

- Landing page + live demo: `https://<your-url>/`
- Owner login/register: `https://<your-url>/login.html`
- Health check: `https://<your-url>/healthz`

Every `git push` to `main` auto-deploys.

### Good to know about the free tier
- The server **sleeps after ~15 min of no visitors**, so the *first* visit after
  idle takes ~30–50 seconds to wake up. Your **data is safe** the whole time
  (it's in Turso, not on the server). Before showing a cafe, open the link once
  to wake it.
- When a cafe pays you, you can remove the cold-start by switching Render to the
  Starter plan ($7/mo) — change `plan: free` to `plan: starter` in `render.yaml`.
  Your data stays exactly where it is (Turso); nothing migrates.

## Running on your own computer
Still works with no setup — just double-click **START-APP.bat**. With no Turso
variables set, it uses a local `cafe.db` file exactly as before.

## First-run checklist
1. Open the URL, click **Start free**, register your cafe.
2. Add your real menu (upload photos), set your UPI ID in Settings.
3. Add tables, then **Print QR codes** and stick them on tables.
4. Set `BASE_URL` so password-reset emails point to the live site.
