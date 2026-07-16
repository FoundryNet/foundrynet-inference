"use strict";
/**
 * Standard x402 v2 payment middleware — dual rail (Solana default, Base/CDP optional).
 *
 * Rail is chosen by env:
 *   X402_RAIL=base  (or CDP creds + BASE_WALLET_ADDRESS present) → Base mainnet USDC,
 *                    settled via the Coinbase CDP facilitator.
 *   else            → Solana mainnet USDC, self-settled via Helius getTransaction
 *                    (the rail our 15 servers use; validated on 402 Index).
 *
 * Both emit the SAME standard x402 v2 schema (accepts[] + base64 PAYMENT-REQUIRED
 * header). An `fnet_` Forge key bypasses on either rail. Switching rails is config
 * only — no code change, no schema change for directory listings.
 */

const USDC_DECIMALS = 6;
const crypto = require("crypto");
const VALID_KEY_HASHES = new Set(
  (process.env.FNET_VALID_KEY_HASHES || "").split(",").map((s) => s.trim()).filter(Boolean)
);
// Only an allowlisted, sha256-hashed fnet_ Forge key bypasses; anything else falls
// through to x402 (no free data on a junk bearer). Seeded from forge_api_keys.
function validFnetKey(k) {
  k = String(k || "").trim();
  return k.startsWith("fnet_") &&
    VALID_KEY_HASHES.has(crypto.createHash("sha256").update(k).digest("hex"));
}
const PUBLIC_URL = (process.env.PUBLIC_URL || "https://foundrynet-inference-production.up.railway.app").replace(/\/$/, "");
const EXPIRY = parseInt(process.env.PAYMENT_EXPIRY_SECONDS || "300", 10);

// ── Rail selection ───────────────────────────────────────────────────────────
const BASE_WALLET = process.env.BASE_WALLET_ADDRESS || "";
const HAS_CDP = !!(process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET);
const RAIL = (process.env.X402_RAIL || (BASE_WALLET && HAS_CDP ? "base" : "solana")).toLowerCase();

const CDP_FACILITATOR = (process.env.CDP_FACILITATOR_URL || "https://api.cdp.coinbase.com/platform/v2/x402").replace(/\/$/, "");

// Base mainnet
const BASE_NETWORK = "eip155:8453";
const BASE_USDC = process.env.BASE_USDC_ASSET || "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

// Solana mainnet
const SOL_NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SOL_PAY_TO = process.env.PAYMENT_RECIPIENT || "wUumjWJjfn27VQhTXd1jUNTzszCmsErkzaEeHWbLThd";
const SOL_USDC = process.env.PAYMENT_USDC_MINT || "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL_RPC = process.env.PAYMENT_VERIFY_RPC ||
  (process.env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` : "https://api.mainnet-beta.solana.com");

const RAIL_CFG = RAIL === "base"
  ? { network: BASE_NETWORK, asset: BASE_USDC, payTo: BASE_WALLET, networkName: "base-mainnet" }
  : { network: SOL_NETWORK, asset: SOL_USDC, payTo: SOL_PAY_TO, networkName: "solana-mainnet" };

const usedTx = new Set(); // in-memory replay guard (Solana self-settle)

function atomic(p) { return String(Math.round(p * 10 ** USDC_DECIMALS)); }
function intentFor(route) { return `fnet-inference-${route}`.slice(0, 64); }

function acceptsEntry(route, priceUsdc, description) {
  const amount = atomic(priceUsdc);
  const extra = { networkName: RAIL_CFG.networkName, assetSymbol: "USDC" };
  if (RAIL !== "base") { extra.feePayer = RAIL_CFG.payTo; extra.memo = intentFor(route); }
  return {
    scheme: "exact",
    network: RAIL_CFG.network,
    amount,                       // v2 field
    maxAmountRequired: amount,    // v1 alias (legacy indexers)
    asset: RAIL_CFG.asset,
    payTo: RAIL_CFG.payTo,
    resource: `${PUBLIC_URL}/x402/${route}`,
    description,
    mimeType: "application/json",
    maxTimeoutSeconds: EXPIRY,
    extra,
    outputSchema: { input: { type: "http", method: "POST" }, output: { type: "application/json" } },
  };
}

function paymentRequired(route, priceUsdc, description, reason) {
  return {
    x402Version: 2,
    error: reason || "PAYMENT-SIGNATURE header is required",
    resource: { url: `${PUBLIC_URL}/x402/${route}`, description, mimeType: "application/json" },
    accepts: [acceptsEntry(route, priceUsdc, description)],
    metadata: {
      name: "FoundryNet Inference",
      description: "x402 LLM proxy + data-enriched analysis + predictive (IoT) intelligence.",
      network: "FoundryNet Data Network", homepage: "https://foundrynet.io", attestation: "MINT Protocol",
      rail: RAIL,
    },
    extensions: {},
  };
}

function challengeHeader(route, priceUsdc, description) {
  return Buffer.from(JSON.stringify(paymentRequired(route, priceUsdc, description))).toString("base64");
}

// ── Solana self-settle verification (Helius getTransaction) ──────────────────
async function verifySolana(tx, priceUsdc, route) {
  if (!tx || usedTx.has(tx)) return false;
  const need = Math.round(priceUsdc * 10 ** USDC_DECIMALS);
  try {
    const r = await fetch(SOL_RPC, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction",
        params: [tx, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }] }) });
    const j = await r.json();
    const res = j && j.result;
    if (!res || (res.meta && res.meta.err != null)) return false;
    const meta = res.meta || {};
    const pre = {};
    for (const b of meta.preTokenBalances || []) pre[b.accountIndex] = b;
    let delta = 0;
    for (const b of meta.postTokenBalances || []) {
      if (b.mint === SOL_USDC && b.owner === SOL_PAY_TO) {
        const post = parseInt(b.uiTokenAmount.amount, 10);
        const prev = parseInt((pre[b.accountIndex]?.uiTokenAmount?.amount) || "0", 10);
        delta = Math.max(delta, post - prev);
      }
    }
    if (delta < need) return false;
    if (!(meta.logMessages || []).join(" ").includes(intentFor(route))) return false;
    usedTx.add(tx);
    return true;
  } catch { return false; }
}

// ── Base verification via the Coinbase CDP facilitator ───────────────────────
// Needs CDP_API_KEY_ID/SECRET. The buyer's payment proof arrives in the
// PAYMENT-SIGNATURE (v2) / X-PAYMENT (v1) header as a base64 PaymentPayload.
async function verifyBase(req, route, priceUsdc, description) {
  if (!HAS_CDP) return false;
  const hdr = req.headers["payment-signature"] || req.headers["x-payment"];
  if (!hdr) return false;
  let paymentPayload;
  try { paymentPayload = JSON.parse(Buffer.from(String(hdr), "base64").toString("utf8")); }
  catch { return false; }
  const paymentRequirements = acceptsEntry(route, priceUsdc, description);
  try {
    // Lazy-load CDP auth so a bad import can never crash the (default) Solana service.
    const { generateJwt } = require("@coinbase/cdp-sdk/auth");
    const host = new URL(CDP_FACILITATOR).host;
    const callFac = async (path) => {
      const jwt = await generateJwt({
        apiKeyId: process.env.CDP_API_KEY_ID, apiKeySecret: process.env.CDP_API_KEY_SECRET,
        requestMethod: "POST", requestHost: host, requestPath: `/platform/v2/x402${path}`,
      });
      const r = await fetch(`${CDP_FACILITATOR}${path}`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements }) });
      return r.json().catch(() => ({}));
    };
    const v = await callFac("/verify");
    if (!v || v.isValid !== true) return false;
    const s = await callFac("/settle");
    return !!(s && s.success);
  } catch { return false; }
}

/** Express middleware factory for a priced route. */
function x402(route, priceUsdc, description) {
  return async function (req, res, next) {
    const auth = req.headers["authorization"] || "";
    const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : null;
    if (bearer && validFnetKey(bearer)) { req.billing = "api_key"; return next(); }

    const send402 = (reason) => {
      res.set("PAYMENT-REQUIRED", challengeHeader(route, priceUsdc, description));
      res.set("WWW-Authenticate", 'x402 version="2"');
      res.set("Access-Control-Allow-Origin", "*");
      return res.status(402).json(paymentRequired(route, priceUsdc, description, reason));
    };

    let ok = false;
    if (RAIL === "base") {
      ok = await verifyBase(req, route, priceUsdc, description);
      if (!ok) return send402("Base USDC payment required (settle via CDP facilitator).");
    } else {
      const tx = req.headers["x-payment-tx"] || (req.body && req.body.payment_tx);
      if (!tx) return send402();
      ok = await verifySolana(tx, priceUsdc, route);
      if (!ok) return send402("Payment not verified on-chain (not confirmed, underpaid, replayed, or memo mismatch).");
    }
    req.billing = "paid";
    return next();
  };
}

/** Gate for MCP tool calls: an fnet_ key (tool arg or Authorization header) bypasses;
 * otherwise return a payment_required object guiding the agent to the x402 REST flow. */
function gateForMcp(route, priceUsdc, description, apiKey) {
  if (apiKey && validFnetKey(apiKey)) return { paid: true, billing: "api_key" };
  return { paid: false, payment_required: paymentRequired(route, priceUsdc, description,
    `Payment required ($${priceUsdc}). Pass an fnet_ Forge key as api_key, or pay via the x402 endpoint ${PUBLIC_URL}/v1/${route}.`) };
}

module.exports = { x402, paymentRequired, acceptsEntry, intentFor, challengeHeader, gateForMcp, RAIL, RAIL_CFG, PUBLIC_URL };
