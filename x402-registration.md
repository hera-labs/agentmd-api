# AgentMD — x402 / agent directory registration

**Honesty first:** x402 discovery is young and fragmented. Listings below were verified as real public projects/docs as of the research pass for this pack. Always re-check live URLs and fees before paying any “listing” charge. This is not an endorsement.

AgentMD already ships discovery endpoints your deploy URL should expose:

| Path | Purpose |
| --- | --- |
| `GET /.well-known/x402` | Machine-readable resources + `accepts` payment requirements |
| `GET /.well-known/agent-card.json` | Compact agent card (endpoint, price, payTo) |
| `GET /openapi.json` | Full OpenAPI 3 schema |
| `Link` response headers | Point agents at OpenAPI + x402 well-known |

---

## 1) OrbitX402 (Solana-oriented discovery)

- Docs: https://orbitx402.com/docs
- Skill file agents paste: `curl https://api.orbitx402.com/skill.md`
- **Register your server** (HTTPS required):

```bash
curl -X POST https://api.orbitx402.com/api/servers/register \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://YOUR-APP.onrender.com",
    "title": "AgentMD",
    "description": "Web page to clean Markdown. Pay-per-call USDC on Solana. Zero custody."
  }'
```

Orbit probes `/.well-known/x402` automatically. Rate limit mentioned in their docs: ~5 registrations / hour / IP.

Verify:

```bash
curl "https://api.orbitx402.com/api/servers/detail?url=https://YOUR-APP.onrender.com"
```

---

## 2) Agora402 (agent registry — Base / Solana / Polygon)

- Site: https://agora402.io/
- Docs: https://agora402.io/docs
- Discovery example: `GET https://agora402.io/api/v1/discover?chain=solana`
- Listing may require a **one-time USDC listing fee** paid to their published treasury (check live docs — fees and wallets change). Prefer **native x402 mode** so payments still go directly to *your* `payTo`, not through a custodian you do not control.

Before listing: confirm whether their “managed” proxy mode would route user calls through them (may conflict with your zero-custody preference). Prefer native mode.

---

## 3) x402 List (open directory)

- Site: https://x402-list.com/
- API: https://x402-list.com/api/v1/services
- Submit / import flows can change — open the site and use their current “submit” or docs. Ensure your 402 envelope is crawlable (`POST /v1/scrape` without payment returns 402).

---

## 4) Coinbase / x402 facilitator ecosystem

- Coinbase Developer Platform documents x402 **facilitator** verify/settle APIs.
- AgentMD’s default mode is **direct-transfer-then-prove** (you verify inbound txs yourself; you do not rely on a facilitator submitting txs).
- If you later adopt full `@x402/*` middleware + a facilitator, re-read:
  - https://solana.com/docs/payments/agentic-payments/x402
  - https://github.com/x402-foundation/x402 (spec v2)
  - Coinbase CDP x402 verify docs
- **Do not claim “full x402 facilitator compatibility”** in listings until you integrate a conforming settle path. Say: *“HTTP 402 + x402 V2-shaped PaymentRequired; direct Solana USDC to operator wallet; proof by tx signature.”*

---

## 5) Practical checklist if a directory is unclear

1. Deploy HTTPS URL with `/health`, `/openapi.json`, `/.well-known/x402`.
2. Confirm unpaid `POST /v1/scrape` returns **402** + `PAYMENT-REQUIRED` header.
3. Put repo + one-paragraph README on GitHub.
4. Post once on X/Twitter + relevant Solana / agent Discords with the URL (no spam).
5. Search terms to find new registries:  
   `x402 directory`, `x402 registry`, `orbitx402`, `agora402`, `x402-list`, `solana agent skills`, `mcp server directory`.
6. Never invent registry URLs — if you cannot verify them live, skip.

---

## 6) What to double-check against the live x402 spec

AgentMD mirrors these verified V2 ideas:

- HTTP **402**
- Headers: `PAYMENT-REQUIRED` → `PAYMENT-SIGNATURE` → `PAYMENT-RESPONSE` (base64 JSON)
- CAIP-2 networks: `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` (mainnet), `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` (devnet)
- Requirement fields: `scheme`, `network`, `amount` (atomic), `asset` (mint), `payTo`, `maxTimeoutSeconds`, `extra`

AgentMD **differs** on purpose (zero custody):

- Full x402 Solana `exact` often has the client sign a payload that a **facilitator settles**.
- AgentMD asks the client to **already transfer** USDC to `payTo`, then send the **txid** as proof.
- Facilitation / EIP-3009-style authorize-then-settle is **not** implemented here.

Before marketing “x402 compatible,” re-read the live Solana x402 guide and decide whether to (a) keep direct-prove and label it clearly, or (b) upgrade to `@x402/express` + facilitator while still setting `payTo` to your personal pubkey.
