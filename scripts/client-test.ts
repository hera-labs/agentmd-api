/**
 * scripts/client-test.ts — agent-like client for AgentMD
 * -----------------------------------------------------
 * Flow:
 *   1) POST /v1/scrape without payment → expect HTTP 402
 *   2) Print payTo / amount so a real agent could pay
 *   3) If TEST_MODE=true on the server, retry with a fake signature
 *      and print the Markdown.
 *
 * Real mainnet payment is NOT automated here on purpose:
 * funding / signing needs YOUR agent wallet — never paste seed phrases
 * into scripts committed to git.
 *
 * Run:
 *   # Terminal A: TEST_MODE=true npm run dev
 *   # Terminal B:
 *   AGENTMD_BASE_URL=http://localhost:8787 npm run test:client
 */

const BASE = (process.env.AGENTMD_BASE_URL || "http://localhost:8787").replace(
  /\/$/,
  ""
);
const TARGET_URL = process.env.SCRAPE_URL || "https://example.com";
const REAL_TX = process.env.PAYMENT_TX_SIGNATURE || "";

async function main() {
  console.log(`AgentMD client → ${BASE}`);
  console.log(`Target page   → ${TARGET_URL}\n`);

  // --- Step 1: unpaid call (expect 402) ---
  const unpaid = await fetch(`${BASE}/v1/scrape`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ url: TARGET_URL }),
  });

  const unpaidBody = await unpaid.json();
  console.log(`Unpaid status: ${unpaid.status}`);
  if (unpaid.status !== 402) {
    console.error("Expected HTTP 402 Payment Required on first call.");
    console.dir(unpaidBody, { depth: 6 });
    process.exit(1);
  }

  const header = unpaid.headers.get("PAYMENT-REQUIRED");
  if (header) {
    try {
      const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
      console.log("PAYMENT-REQUIRED header decoded OK (x402-shaped).");
      console.log(`  payTo:  ${decoded.accepts?.[0]?.payTo}`);
      console.log(`  amount: ${decoded.accepts?.[0]?.amount} (atomic USDC)`);
      console.log(`  asset:  ${decoded.accepts?.[0]?.asset}`);
    } catch {
      console.warn("Could not decode PAYMENT-REQUIRED header.");
    }
  }

  console.log("\nBody.agentmd summary:");
  console.dir(unpaidBody.agentmd ?? unpaidBody.accepts?.[0], { depth: 4 });

  console.log(`
----------------------------------------------------------
To pay for REAL (mainnet / funded wallet):
  1) Send the exact USDC amount to payTo on Solana.
  2) Copy the transaction signature (txid).
  3) Re-run:
       PAYMENT_TX_SIGNATURE=<txid> npm run test:client

Or for LOCAL scrape testing only, start the server with:
       TEST_MODE=true npm run dev
  then re-run this script (it will send a fake proof).
----------------------------------------------------------
`);

  // --- Step 2: paid / mock retry ---
  const proof =
    REAL_TX ||
    (process.env.FORCE_MOCK_PROOF === "true" ? "test-sig-local" : "");

  // Auto-mock when server health says testMode
  let useProof = proof;
  if (!useProof) {
    try {
      const health = await (await fetch(`${BASE}/health`)).json();
      if (health.testMode) {
        useProof = "test-sig-local";
        console.log("Server TEST_MODE=true → using mock payment proof.\n");
      }
    } catch {
      /* ignore */
    }
  }

  if (!useProof) {
    console.log("No payment proof available yet — stopping after 402 demo.");
    return;
  }

  const paid = await fetch(`${BASE}/v1/scrape`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      // Beginner-friendly raw tx header; PAYMENT-SIGNATURE also works:
      "X-Payment-Tx": useProof,
    },
    body: JSON.stringify({ url: TARGET_URL, paymentTxSignature: useProof }),
  });

  const paidBody = await paid.json();
  console.log(`Paid status: ${paid.status}`);
  if (paid.status !== 200) {
    console.error("Payment / scrape failed:");
    console.dir(paidBody, { depth: 6 });
    process.exit(1);
  }

  console.log(`\nTitle: ${paidBody.title}`);
  console.log("--- Markdown (first 800 chars) ---\n");
  console.log(String(paidBody.markdown || "").slice(0, 800));
  console.log("\n--- end preview ---");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
