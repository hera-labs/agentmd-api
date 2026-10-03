/**
 * AgentMD API server (Hono + Node)
 * -------------------------------
 * POST /v1/scrape  → pay-per-call Web-to-Markdown
 * GET  /health
 * GET  /openapi.json
 * GET  /openapi.yaml
 * GET  /.well-known/x402
 * GET  /.well-known/agent-card.json
 *
 * Payment model (ZERO CUSTODY):
 * 1) Client POSTs { url } with no payment → HTTP 402 + PAYMENT-REQUIRED
 * 2) Client pays USDC on Solana directly to RECEIVER_WALLET
 * 3) Client retries with payment proof (tx signature)
 * 4) Server verifies on-chain via RPC, scrapes, returns Markdown
 *
 * The server NEVER creates / signs / routes user funds.
 */

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { scrapeToMarkdown, ScrapeError } from "./scrape.js";
import {
  buildPaymentRequired,
  encodePaymentRequiredHeader,
  extractTxSignature,
  loadPaymentConfigFromEnv,
  verifyPayment,
  type PaymentConfig,
} from "./verify-payment.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

let cfg: PaymentConfig;
try {
  cfg = loadPaymentConfigFromEnv();
} catch (err) {
  console.error("[AgentMD] Config error:", err instanceof Error ? err.message : err);
  process.exit(1);
}

if (cfg.testMode) {
  console.warn("==========================================================");
  console.warn("  WARNING: TEST_MODE=true — on-chain payment verify SKIPPED");
  console.warn("  Use ONLY on localhost. NEVER in production.");
  console.warn("==========================================================");
}

const app = new Hono();

app.use(
  "*",
  cors({
    origin: "*",
    exposeHeaders: [
      "PAYMENT-REQUIRED",
      "PAYMENT-RESPONSE",
      "Link",
      "Content-Type",
    ],
    allowHeaders: [
      "Content-Type",
      "PAYMENT-SIGNATURE",
      "X-Payment-Tx",
      "Accept",
    ],
  })
);

app.use(
  "*",
  bodyLimit({
    maxSize: 32 * 1024, // 32 KB JSON bodies are plenty for { url, paymentTxSignature }
    onError: (c) => c.json({ error: "request_body_too_large" }, 413),
  })
);

/** Attach OpenAPI discovery Link header on every response. */
app.use("*", async (c, next) => {
  await next();
  const base = publicBase(c);
  c.res.headers.append(
    "Link",
    `<${base}/openapi.json>; rel="service-doc"; type="application/json"`
  );
  c.res.headers.append(
    "Link",
    `<${base}/.well-known/x402>; rel="payment-required-discovery"; type="application/json"`
  );
});

function publicBase(c: { req: { url: string } }): string {
  if (process.env.PUBLIC_BASE_URL) {
    return process.env.PUBLIC_BASE_URL.replace(/\/$/, "");
  }
  try {
    const u = new URL(c.req.url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "http://localhost:8787";
  }
}

app.get("/health", (c) =>
  c.json({
    ok: true,
    service: "AgentMD",
    version: "1.0.0",
    testMode: cfg.testMode,
    network: cfg.network,
    priceUsdc: cfg.priceUsdc,
    // Never a financial product — technical scrape tool only.
    purpose: "technical_web_to_markdown",
  })
);

app.get("/openapi.json", (c) => {
  return c.json(buildOpenApi(publicBase(c)), 200, {
    "Content-Type": "application/json; charset=utf-8",
  });
});

app.get("/openapi.yaml", (c) => {
  const yamlPath = join(ROOT, "openapi.yaml");
  if (existsSync(yamlPath)) {
    const text = readFileSync(yamlPath, "utf8");
    // Rewrite servers URL if needed
    return c.body(text, 200, { "Content-Type": "application/yaml; charset=utf-8" });
  }
  return c.body(YAML.stringify(buildOpenApi(publicBase(c))), 200, {
    "Content-Type": "application/yaml; charset=utf-8",
  });
});

/** x402 / agent discovery document — probed by OrbitX402 and similar registries. */
app.get("/.well-known/x402", (c) => {
  const base = publicBase(c);
  const challenge = buildPaymentRequired(cfg, `${base}/v1/scrape`);
  return c.json({
    name: "AgentMD",
    description:
      "Agentic Web-to-Markdown API. Pay-per-call USDC on Solana. Zero custody — pay the operator wallet directly, then scrape.",
    version: "1.0.0",
    x402Version: 2,
    resources: [
      {
        method: "POST",
        path: "/v1/scrape",
        url: `${base}/v1/scrape`,
        description: "Fetch a public URL and return cleaned Markdown.",
        mimeType: "application/json",
        accepts: challenge.accepts,
      },
    ],
    openapi: `${base}/openapi.json`,
    health: `${base}/health`,
    settlementMode: "direct-transfer-then-prove",
    note:
      "Challenge fields mirror x402 V2. Settlement is direct on-chain transfer to payTo; prove with tx signature. Double-check live x402 specs before advertising full facilitator compatibility.",
  });
});

app.get("/.well-known/agent-card.json", (c) => {
  const base = publicBase(c);
  return c.json({
    name: "AgentMD",
    description: "Web page → clean Markdown for AI agents. Pay-per-call via Solana USDC (HTTP 402).",
    url: base,
    endpoints: {
      scrape: `${base}/v1/scrape`,
      health: `${base}/health`,
      openapi: `${base}/openapi.json`,
      x402: `${base}/.well-known/x402`,
    },
    payment: {
      protocol: "x402-inspired-direct-pay",
      x402Version: 2,
      network: cfg.network,
      asset: "USDC",
      priceUsdc: cfg.priceUsdc,
      payTo: cfg.receiverWallet,
    },
    categories: ["web-scraping", "markdown", "data-extraction"],
  });
});

type ScrapeBody = {
  url?: string;
  paymentTxSignature?: string;
};

app.post("/v1/scrape", async (c) => {
  let body: ScrapeBody = {};
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json_body" }, 400);
  }

  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (!url) {
    return c.json({ error: "missing_url", hint: 'Body must be JSON: { "url": "https://..." }' }, 400);
  }

  const txSig = extractTxSignature({
    paymentSignatureHeader: c.req.header("PAYMENT-SIGNATURE"),
    paymentTxHeader: c.req.header("X-Payment-Tx"),
    bodyTx: body.paymentTxSignature ?? null,
  });

  const resourceUrl = `${publicBase(c)}/v1/scrape`;
  const paymentRequired = buildPaymentRequired(cfg, resourceUrl);

  if (!txSig) {
    // HTTP 402 Payment Required — x402 V2 header + readable JSON body
    const headerVal = encodePaymentRequiredHeader(paymentRequired);
    return c.json(paymentRequired, 402, {
      "PAYMENT-REQUIRED": headerVal,
      "Cache-Control": "no-store",
    });
  }

  const verified = await verifyPayment(cfg, txSig);
  if (!verified.ok) {
    return c.json(
      {
        ...paymentRequired,
        error: "payment_verification_failed",
        reason: verified.reason,
      },
      402,
      {
        "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired),
        "Cache-Control": "no-store",
      }
    );
  }

  try {
    const result = await scrapeToMarkdown(url);
    const settlement = {
      success: true,
      transaction: verified.signature,
      asset: verified.asset,
      amountAtomic: verified.amountAtomic,
      explorerUrl: verified.explorerUrl,
      network: paymentRequired.accepts[0]?.network,
    };
    return c.json(
      {
        markdown: result.markdown,
        url: result.url,
        title: result.title,
        meta: {
          ...result.meta,
          payment: {
            asset: verified.asset,
            transaction: verified.signature,
            explorerUrl: verified.explorerUrl,
          },
        },
      },
      200,
      {
        "PAYMENT-RESPONSE": Buffer.from(JSON.stringify(settlement), "utf8").toString(
          "base64"
        ),
        "Content-Type": "application/json; charset=utf-8",
      }
    );
  } catch (err) {
    if (err instanceof ScrapeError) {
      return c.json({ error: "scrape_failed", message: err.message }, err.status as 400);
    }
    console.error("[AgentMD] scrape error", err);
    return c.json({ error: "internal_error" }, 500);
  }
});

app.notFound((c) =>
  c.json(
    {
      error: "not_found",
      hint: "Try GET /health, GET /openapi.json, or POST /v1/scrape",
    },
    404
  )
);

function buildOpenApi(base: string) {
  return {
    openapi: "3.0.3",
    info: {
      title: "AgentMD — Agentic Web-to-Markdown API",
      version: "1.0.0",
      description:
        "Convert a public web page to clean Markdown. Pay-per-call with Solana USDC via HTTP 402 (x402-shaped, direct-to-wallet, zero custody). Not a financial product.",
      contact: { name: "AgentMD operator" },
    },
    servers: [{ url: base }],
    paths: {
      "/health": {
        get: {
          summary: "Liveness / config snapshot",
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": {
                  schema: { type: "object" },
                },
              },
            },
          },
        },
      },
      "/v1/scrape": {
        post: {
          summary: "Scrape URL → Markdown (payment required)",
          description:
            "Without payment proof returns 402 + PAYMENT-REQUIRED. With a verified Solana tx signature, returns Markdown.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["url"],
                  properties: {
                    url: {
                      type: "string",
                      format: "uri",
                      description: "Public http(s) URL to convert",
                      example: "https://example.com",
                    },
                    paymentTxSignature: {
                      type: "string",
                      description:
                        "Solana transaction signature proving USDC payment to payTo (alternative to PAYMENT-SIGNATURE header)",
                    },
                  },
                },
              },
            },
          },
          parameters: [
            {
              name: "PAYMENT-SIGNATURE",
              in: "header",
              required: false,
              schema: { type: "string" },
              description:
                "Base64-encoded PaymentPayload JSON. For AgentMD direct-pay mode, payload.transaction is the Solana tx signature.",
            },
            {
              name: "X-Payment-Tx",
              in: "header",
              required: false,
              schema: { type: "string" },
              description: "Raw Solana tx signature (beginner-friendly alternative).",
            },
          ],
          responses: {
            "200": {
              description: "Markdown result",
              headers: {
                "PAYMENT-RESPONSE": {
                  schema: { type: "string" },
                  description: "Base64 SettlementResponse-like JSON",
                },
              },
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ScrapeSuccess" },
                },
              },
            },
            "402": {
              description: "Payment required or payment verification failed",
              headers: {
                "PAYMENT-REQUIRED": {
                  schema: { type: "string" },
                  description: "Base64 PaymentRequired JSON (x402 V2-shaped)",
                },
              },
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/PaymentRequired" },
                },
              },
            },
            "400": { description: "Bad request" },
            "413": { description: "Body too large" },
            "502": { description: "Upstream fetch failed" },
          },
        },
      },
    },
    components: {
      schemas: {
        ScrapeSuccess: {
          type: "object",
          properties: {
            markdown: { type: "string" },
            url: { type: "string" },
            title: { type: "string", nullable: true },
            meta: { type: "object" },
          },
          required: ["markdown", "url", "meta"],
        },
        PaymentRequired: {
          type: "object",
          properties: {
            x402Version: { type: "integer", example: 2 },
            error: { type: "string", example: "PAYMENT_REQUIRED" },
            resource: { type: "object" },
            accepts: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  scheme: { type: "string", example: "exact" },
                  network: {
                    type: "string",
                    example: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
                  },
                  amount: { type: "string", description: "Atomic USDC units" },
                  asset: { type: "string", description: "USDC mint address" },
                  payTo: { type: "string" },
                  maxTimeoutSeconds: { type: "integer" },
                  extra: { type: "object" },
                },
              },
            },
            agentmd: { type: "object" },
          },
        },
      },
    },
  };
}

const port = Number(process.env.PORT || 8787);
console.log(`[AgentMD] listening on :${port}`);
console.log(`[AgentMD] network=${cfg.network} priceUsdc=${cfg.priceUsdc} payTo=${cfg.receiverWallet}`);
serve({ fetch: app.fetch, port });
