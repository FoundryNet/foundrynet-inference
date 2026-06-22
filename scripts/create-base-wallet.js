"use strict";
/**
 * One-off: create (or fetch) the Base-mainnet EVM receiving wallet via the CDP SDK,
 * and print its 0x address — this becomes BASE_WALLET_ADDRESS (the x402 payTo).
 *
 * Requires these env vars (from the CDP portal):
 *   CDP_API_KEY_ID, CDP_API_KEY_SECRET, CDP_WALLET_SECRET
 *
 * Run it where those are set, e.g. on Railway after the secrets are configured:
 *   railway run --service foundrynet-inference node scripts/create-base-wallet.js
 * The wallet SECRET is only needed HERE (creation/management); the running payment
 * service never needs it — only CDP_API_KEY_ID/SECRET to receive via the facilitator.
 */

(async () => {
  for (const k of ["CDP_API_KEY_ID", "CDP_API_KEY_SECRET", "CDP_WALLET_SECRET"]) {
    if (!process.env[k]) {
      console.error(`Missing ${k}. Set it (CDP portal) before running.`);
      process.exit(1);
    }
  }
  const { CdpClient } = require("@coinbase/cdp-sdk");
  const cdp = new CdpClient({
    apiKeyId: process.env.CDP_API_KEY_ID,
    apiKeySecret: process.env.CDP_API_KEY_SECRET,
    walletSecret: process.env.CDP_WALLET_SECRET,
  });
  const name = process.env.CDP_WALLET_NAME || "foundrynet-inference-receiver";
  const account = await cdp.evm.getOrCreateAccount({ name }); // idempotent
  console.log("\n=== Base receiving wallet ready ===");
  console.log("name:   ", name);
  console.log("address:", account.address);
  console.log("\nSet this on Railway:  BASE_WALLET_ADDRESS=" + account.address);
  console.log("Then set X402_RAIL=base to switch the service to Base/CDP settlement.\n");
})().catch((e) => { console.error("wallet creation failed:", e.message || e); process.exit(1); });
