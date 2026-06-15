# Deploying ScanServe to Render.com

Your repo is deploy-ready: `render.yaml` defines a web service with a 1 GB
persistent disk for the SQLite database. Follow these steps once.

## 1. Create / sign in to Render
1. Go to **https://render.com** and click **Get Started**.
2. Choose **Sign in with GitHub** and authorize Render for the
   `anilkhileree79764-cyber` account. (You have to do this part yourself —
   account creation and the GitHub authorization can't be automated.)

## 2. Create the service from this repo (Blueprint)
1. In the Render dashboard click **New +** → **Blueprint**.
2. Pick the repository **`anilkhileree79764-cyber/scanserve`**.
3. Render reads `render.yaml` automatically and proposes the `scanserve`
   web service with its disk. Click **Apply**.
4. Confirm the plan shows **Starter ($7/mo)** — this is the one with the
   permanent disk so cafe data is never lost.

## 3. Set the environment variables
In the service's **Environment** tab, add:

| Key | Value | Needed for |
|-----|-------|-----------|
| `BASE_URL` | your live URL, e.g. `https://scanserve.onrender.com` | reset/verify email links |
| `RZP_KEY_ID` / `RZP_KEY_SECRET` | from your Razorpay dashboard | real ₹499 billing (optional — demo billing works without) |
| `SMTP_HOST` `SMTP_PORT` `SMTP_USER` `SMTP_PASS` `SMTP_FROM` | from your email provider | real reset/verify emails (optional — console demo mode otherwise) |

`DB_PATH` and `NODE_ENV` are already set by `render.yaml` — leave them.

You can deploy first with **none** of the optional ones set: billing and email
just run in demo mode until you add the keys.

## 4. Deploy
Render builds and deploys automatically. When it's live you'll get a URL like
`https://scanserve.onrender.com`.

- Owner dashboard: `https://<your-url>/login.html`
- Landing page with live demo: `https://<your-url>/`
- Health check: `https://<your-url>/healthz`

Every future `git push` to `main` auto-deploys.

## 5. First-run checklist
1. Open the URL, click **Start free** and register your cafe.
2. Add your real menu (with photos), set your UPI ID in Settings.
3. Add your tables, then **Print QR codes** and stick them on tables.
4. Set `BASE_URL` (step 3) so password-reset emails point to the live site.
