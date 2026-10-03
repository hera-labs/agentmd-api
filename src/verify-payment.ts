/**
 * verify-payment.ts
 * -----------------
 * ZERO-CUSTODY payment verification for AgentMD.
 *
 * This module NEVER creates, signs, or submits transactions for users.
 * It only READS the Solana blockchain (via RPC) to confirm that a
 * transaction already sent by the agent/client paid enough USDC
 * (or optional SOL) to RECEIVER_WALLET.
 *
 * Beginner note:
 * - "Pubkey" = public wallet address (safe to share; like an IBAN).
 * - "Signature" / "txid" = unique ID of a confirmed on-chain payment.
 * - USDC on Solana uses 6 decimals → 0.01 USDC = 10_000 base units.
 */

import {
  Connection,
  PublicKey,
  type ParsedTransactionWithMeta,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

/** CAIP-2 network IDs used by x402 V2 (from official Solana / x402 docs). */
export const CAIP2 = {
  "mainnet-beta": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  devnet: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
} as const;

export type SolanaCluster = keyof typeof CAIP2;

export interface PaymentConfig {
  receiverWallet: string;
  priceUsdc: number;
  network: SolanaCluster;
  rpcUrl: string;
  usdcMint: string;
  maxTimeoutSeconds: number;
  /** Optional SOL fallback in lamports (1 SOL = 1e9 lamports). Empty = off. */
  acceptSolLamports?: number;
  testMode: boolean;
}

export interface VerifyOk {
  ok: true;
  signature: string;
  asset: "USDC" | "SOL";
  amountAtomic: string;
  explorerUrl: string;
}

export interface VerifyFail {
  ok: false;
  reason: string;
}

/** In-memory replay protection. For multi-instance production, use Redis. */
const usedSignatures = new Set<string>();

export function loadPaymentConfigFromEnv(): PaymentConfig {
  const receiverWallet = process.env.RECEIVER_WALLET?.trim();
  if (!receiverWallet) {
    throw new Error("RECEIVER_WALLET is required (your Solana public address).");
  }

  const network = (process.env.SOLANA_NETWORK || "mainnet-beta") as SolanaCluster;
  if (!(network in CAIP2)) {
    throw new Error(`SOLANA_NETWORK must be mainnet-beta or devnet, got: ${network}`);
  }

  const priceUsdc = Number(process.env.PRICE_USDC ?? "0.01");
  if (!Number.isFinite(priceUsdc) || priceUsdc <= 0) {
    throw new Error("PRICE_USDC must be a positive number (e.g. 0.01).");
  }

  const acceptSol = process.env.ACCEPT_SOL_LAMPORTS?.trim();
  return {
    receiverWallet,
    priceUsdc,
    network,
    rpcUrl: process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
    usdcMint:
      process.env.USDC_MINT ||
      (network === "devnet"
        ? "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
        : "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
    maxTimeoutSeconds: Number(process.env.MAX_TIMEOUT_SECONDS || "300"),
    acceptSolLamports: acceptSol ? Number(acceptSol) : undefined,
    testMode: String(process.env.TEST_MODE || "false").toLowerCase() === "true",
  };
}

/** USDC atomic units (6 decimals). 0.01 USDC → "10000" */
export function priceToUsdcAtomic(priceUsdc: number): string {
  return String(Math.round(priceUsdc * 1_000_000));
}

export function explorerTxUrl(signature: string, network: SolanaCluster): string {
  const cluster = network === "devnet" ? "?cluster=devnet" : "";
  return `https://solscan.io/tx/${signature}${cluster}`;
}

/**
 * Build an x402 V2-shaped PaymentRequired object (plus a readable body twin).
 * Double-check live fields against:
 *   https://solana.com/docs/payments/agentic-payments/x402
 *   https://github.com/x402-foundation/x402 (specs/x402-specification-v2.md)
 *
 * IMPORTANT for zero-custody AgentMD:
 * Full x402 V2 often uses a "facilitator" that settles signed authorizations.
 * AgentMD instead uses a DIRECT-PAY-THEN-PROVE flow: the agent pays on-chain
 * to RECEIVER_WALLET, then resubmits with the transaction signature.
 * Challenge JSON/headers still mirror x402 V2 shapes for agent discovery.
 */
export function buildPaymentRequired(cfg: PaymentConfig, resourceUrl: string) {
  const amount = priceToUsdcAtomic(cfg.priceUsdc);
  const accepts = [
    {
      scheme: "exact",
      network: CAIP2[cfg.network],
      amount,
      asset: cfg.usdcMint,
      payTo: cfg.receiverWallet,
      maxTimeoutSeconds: cfg.maxTimeoutSeconds,
      extra: {
        assetSymbol: "USDC",
        decimals: 6,
        // AgentMD-specific: how agents settle without a facilitator custody path
        settlementMode: "direct-transfer-then-prove",
        proofHeader: "PAYMENT-SIGNATURE",
        proofField: "transaction",
        instructions:
          "1) Transfer exact USDC amount to payTo. 2) Retry POST with PAYMENT-SIGNATURE header (base64 JSON) containing { x402Version:2, accepted, payload:{ transaction: <txid> } } OR body.paymentTxSignature.",
      },
    },
  ];

  if (cfg.acceptSolLamports && cfg.acceptSolLamports > 0) {
    accepts.push({
      scheme: "exact",
      network: CAIP2[cfg.network],
      amount: String(cfg.acceptSolLamports),
      asset: "native",
      payTo: cfg.receiverWallet,
      maxTimeoutSeconds: cfg.maxTimeoutSeconds,
      extra: {
        assetSymbol: "SOL",
        decimals: 9,
        settlementMode: "direct-transfer-then-prove",
        proofHeader: "PAYMENT-SIGNATURE",
        proofField: "transaction",
        instructions:
          "Transfer native SOL (lamports) to payTo, then prove with tx signature.",
      },
    });
  }

  return {
    x402Version: 2,
    error: "PAYMENT_REQUIRED",
    resource: {
      url: resourceUrl,
      description: "Convert a public web page URL into clean Markdown for agents.",
      mimeType: "application/json",
    },
    accepts,
    // Human-friendly twin (same facts, plainer keys) — not part of strict x402 wire
    agentmd: {
      priceUsdc: cfg.priceUsdc,
      priceLabel: `~$${cfg.priceUsdc.toFixed(3)} USDC per call`,
      payTo: cfg.receiverWallet,
      network: cfg.network,
      caip2: CAIP2[cfg.network],
      usdcMint: cfg.usdcMint,
      note:
        "Technical web-scraping tool only. Not a financial product, wallet, exchange, or custody service. Server never holds user funds.",
    },
  };
}

export function encodePaymentRequiredHeader(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}

/**
 * Extract a Solana tx signature from either:
 * - PAYMENT-SIGNATURE header (base64 JSON PaymentPayload-like), or
 * - raw header X-Payment-Tx / body.paymentTxSignature (beginner-friendly)
 */
export function extractTxSignature(opts: {
  paymentSignatureHeader?: string | null;
  paymentTxHeader?: string | null;
  bodyTx?: string | null;
}): string | null {
  const looksLikeSig = (s: string) =>
    s === "test-sig-local" || // TEST_MODE mock only
    /^[1-9A-HJ-NP-Za-km-z]{64,128}$/.test(s);

  if (opts.bodyTx && looksLikeSig(opts.bodyTx.trim())) {
    return opts.bodyTx.trim();
  }
  if (opts.paymentTxHeader && looksLikeSig(opts.paymentTxHeader.trim())) {
    return opts.paymentTxHeader.trim();
  }
  if (opts.paymentSignatureHeader) {
    try {
      const raw = Buffer.from(opts.paymentSignatureHeader, "base64").toString("utf8");
      const parsed = JSON.parse(raw) as {
        payload?: { transaction?: string; signature?: string };
        transaction?: string;
      };
      const tx =
        parsed?.payload?.transaction ||
        parsed?.payload?.signature ||
        parsed?.transaction;
      if (typeof tx === "string" && tx.length >= 64) return tx.trim();
    } catch {
      // fall through
    }
  }
  return null;
}

/**
 * Verify that `signature` is a confirmed Solana tx that paid this service.
 */
export async function verifyPayment(
  cfg: PaymentConfig,
  signature: string
): Promise<VerifyOk | VerifyFail> {
  if (cfg.testMode) {
    // LOCAL ONLY — skips chain checks so you can test scraping without paying.
    console.warn(
      "[AgentMD][TEST_MODE] Skipping on-chain verify. NEVER enable TEST_MODE in production."
    );
    if (usedSignatures.has(signature) && signature !== "test-sig-local") {
      return { ok: false, reason: "signature_already_used" };
    }
    usedSignatures.add(signature);
    return {
      ok: true,
      signature,
      asset: "USDC",
      amountAtomic: priceToUsdcAtomic(cfg.priceUsdc),
      explorerUrl: explorerTxUrl(signature, cfg.network),
    };
  }

  if (usedSignatures.has(signature)) {
    return { ok: false, reason: "signature_already_used" };
  }

  let receiver: PublicKey;
  let mint: PublicKey;
  try {
    receiver = new PublicKey(cfg.receiverWallet);
    mint = new PublicKey(cfg.usdcMint);
  } catch {
    return { ok: false, reason: "invalid_receiver_or_mint_config" };
  }

  const connection = new Connection(cfg.rpcUrl, "confirmed");

  let tx: ParsedTransactionWithMeta | null;
  try {
    tx = await connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
  } catch (err) {
    return {
      ok: false,
      reason: `rpc_error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!tx || !tx.meta || tx.meta.err) {
    return { ok: false, reason: "transaction_not_found_or_failed" };
  }

  const neededUsdc = BigInt(priceToUsdcAtomic(cfg.priceUsdc));

  // --- Path A: USDC (SPL) token balance change on receiver's ATA ---
  const receiverAta = getAssociatedTokenAddressSync(mint, receiver);
  const usdcReceived = sumTokenDeltaToOwner(tx, receiverAta.toBase58());
  if (usdcReceived >= neededUsdc) {
    usedSignatures.add(signature);
    return {
      ok: true,
      signature,
      asset: "USDC",
      amountAtomic: usdcReceived.toString(),
      explorerUrl: explorerTxUrl(signature, cfg.network),
    };
  }

  // --- Path B: optional native SOL ---
  if (cfg.acceptSolLamports && cfg.acceptSolLamports > 0) {
    const solReceived = sumSolDeltaToOwner(tx, receiver.toBase58());
    if (solReceived >= BigInt(cfg.acceptSolLamports)) {
      usedSignatures.add(signature);
      return {
        ok: true,
        signature,
        asset: "SOL",
        amountAtomic: solReceived.toString(),
        explorerUrl: explorerTxUrl(signature, cfg.network),
      };
    }
  }

  return {
    ok: false,
    reason: `insufficient_or_wrong_payment (usdcReceived=${usdcReceived.toString()}, needUsdc=${neededUsdc.toString()})`,
  };
}

/** Sum positive token amount credited to a specific token account in the tx. */
function sumTokenDeltaToOwner(
  tx: ParsedTransactionWithMeta,
  tokenAccount: string
): bigint {
  const meta = tx.meta!;
  const pre = meta.preTokenBalances || [];
  const post = meta.postTokenBalances || [];

  // Match by account index → resolve account keys
  const keys = tx.transaction.message.accountKeys.map((k) =>
    typeof k === "string" ? k : k.pubkey.toBase58()
  );

  let total = 0n;
  for (const postBal of post) {
    const idx = postBal.accountIndex;
    const acct = keys[idx];
    if (acct !== tokenAccount) continue;
    const postAmt = BigInt(postBal.uiTokenAmount.amount);
    const preBal = pre.find((p) => p.accountIndex === idx);
    const preAmt = preBal ? BigInt(preBal.uiTokenAmount.amount) : 0n;
    const delta = postAmt - preAmt;
    if (delta > 0n) total += delta;
  }

  // Fallback: also accept owner-field match when ATA derivation differs
  if (total === 0n) {
    for (const postBal of post) {
      if (postBal.owner !== undefined) {
        // owner here is the wallet, not the ATA — skip; ATA path is preferred
      }
    }
  }

  return total;
}

function sumSolDeltaToOwner(
  tx: ParsedTransactionWithMeta,
  owner: string
): bigint {
  const meta = tx.meta!;
  const keys = tx.transaction.message.accountKeys.map((k) =>
    typeof k === "string" ? k : k.pubkey.toBase58()
  );
  const idx = keys.indexOf(owner);
  if (idx < 0) return 0n;
  const pre = BigInt(meta.preBalances[idx] ?? 0);
  const post = BigInt(meta.postBalances[idx] ?? 0);
  const delta = post - pre;
  return delta > 0n ? delta : 0n;
}

/** For unit/local introspection */
export function _resetUsedSignaturesForTests() {
  usedSignatures.clear();
}
