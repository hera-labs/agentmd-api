# AgentMD — Deploy on Render (free) — click-by-click

**Why Render (not Cloudflare Workers / Vercel as primary)?**

- AgentMD uses Node + `@solana/web3.js` + DNS lookups for SSRF checks.
- Render free **Web Service** runs ordinary Node — `npm install` just works.
- Cloudflare Workers is free and excellent with Hono, but Solana packages + Node DNS APIs need extra polyfills/bundling (harder for a first deploy).
- Vercel is listed as an **alternate** in the short appendix below.

You need: a GitHub account, the AgentMD folder as a git repo, and your Solana **public** address.

---

## A. Push the project to GitHub

1. Open a terminal in `agentic-web-to-md-pack/`.
2. Run:

```bash
git init
git add .
git commit -m "Initial AgentMD API"
```

3. On GitHub.com → **New repository** → name it e.g. `agentmd-api` → create (empty, no README).
4. Link and push (GitHub will show the exact commands; typically):

```bash
git branch -M main
git remote add origin https://github.com/YOUR_USER/agentmd-api.git
git push -u origin main
```

---

## B. Create the Render Web Service

1. Go to [https://render.com](https://render.com) → **Sign Up** (GitHub login is easiest).
2. Dashboard → **New +** → **Web Service**.
3. **Connect** your GitHub account if asked → select repo `agentmd-api`.
4. Fill the form:

| Field | Value |
| --- | --- |
| Name | `agentmd-api` (or any name) |
| Region | Pick closest to you |
| Branch | `main` |
| Runtime | **Node** |
| Build Command | `npm install && npm run build` |
| Start Command | `npm start` |
| Instance type | **Free** |

5. Open **Environment** (or Advanced → Environment Variables) and add:

| Key | Value |
| --- | --- |
| `RECEIVER_WALLET` | Your Phantom/Backpack **public** address |
| `PRICE_USDC` | `0.01` (or `0.005` for entry pricing) |
| `SOLANA_NETWORK` | `mainnet-beta` |
| `SOLANA_RPC_URL` | `https://api.mainnet-beta.solana.com` (upgrade later to Helius/QuickNode free) |
| `USDC_MINT` | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| `MAX_TIMEOUT_SECONDS` | `300` |
| `TEST_MODE` | `false` |
| `PUBLIC_BASE_URL` | Leave blank on first deploy; set after you know the URL |

6. Click **Create Web Service**.
7. Wait for the first deploy (several minutes). Open the service URL, e.g. `https://agentmd-api.onrender.com`.
8. In Environment, set `PUBLIC_BASE_URL` to that exact HTTPS URL → **Save** → trigger **Manual Deploy** → **Deploy latest commit**.

---

## C. Smoke-test production

```bash
curl -s https://YOUR-APP.onrender.com/health | jq

curl -si -X POST https://YOUR-APP.onrender.com/v1/scrape \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com"}'
```

You should see **HTTP/402** and a JSON body with `accepts[0].payTo` equal to your wallet.

**Free tier note:** Render free services **spin down** after idle time; the first request after sleep can take ~30–60s. That is normal for zero-ops hobby hosting.

---

## D. Optional: custom domain

Render → your service → **Settings** → **Custom Domains** → add domain → follow DNS instructions → update `PUBLIC_BASE_URL`.

---

## Appendix — Vercel alternate (short)

Vercel can run this as a serverless function, but cold starts + Solana RPC + long scrapes are a poorer fit than a small always-on/spin-down Node service. If you insist:

1. Add an `api/index.ts` adapter (Hono on Vercel) — not included as primary.
2. Set the same env vars in Vercel → Project → Settings → Environment Variables.
3. Prefer Render until you are comfortable with serverless limits.

## Appendix — Cloudflare Workers (later upgrade)

When you want global edge:

1. `npm create hono@latest` Workers template.
2. Port `src/server.ts` fetch handler (already Hono).
3. Replace Node `dns/promises` SSRF check with Workers-compatible IP validation or a DoH lookup.
4. Bundle carefully; test `@solana/web3.js` size limits.
5. `npx wrangler deploy`.

Stick with Render for the first live URL.
