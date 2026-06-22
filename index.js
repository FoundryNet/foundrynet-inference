"use strict";
/**
 * FoundryNet Inference — x402-gated revenue engine.
 *   Tier 1  POST /v1/chat     $0.02  generic LLM proxy (Claude)
 *   Tier 2  POST /v1/analyze  $0.25  data-enriched analysis (17 sources + LLM)
 *   Tier 3  POST /v1/predict  $0.10  TimesFM breach forecast + NL recommendation
 *           POST /v1/infer    $0.10  IoT telemetry → normalize + forecast + anomalies
 *
 * Payment: standard x402 v2 on Solana (self-settled, Base-ready). See lib/x402.js.
 */

const express = require("express");
const { x402, PUBLIC_URL, RAIL, RAIL_CFG } = require("./lib/x402");
const handlers = require("./lib/handlers");
const { mountMcp, TOOLS } = require("./lib/mcp");

const app = express();
app.use(express.json({ limit: "2mb" }));

const ROUTES = {
  chat: { price: 0.02, desc: "LLM inference proxy (Claude)" },
  analyze: { price: 0.25, desc: "Data-enriched analysis across the FoundryNet network + LLM" },
  predict: { price: 0.10, desc: "Predictive telemetry — TimesFM breach forecast + NL recommendation" },
  infer: { price: 0.10, desc: "IoT sensor inference — normalize + forecast + anomaly flags" },
};

// ── Health + discovery ──────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ status: "ok", service: "foundrynet-inference", tiers: Object.keys(ROUTES) }));

function discoveryIndex() {
  return {
    x402Version: 2,
    name: "FoundryNet Inference",
    description: "x402 LLM proxy + data-enriched analysis + predictive (IoT) intelligence.",
    network: "FoundryNet Data Network",
    rail: RAIL, asset: RAIL_CFG.asset, chain: RAIL_CFG.network, payTo: RAIL_CFG.payTo,
    resources: Object.entries(ROUTES).map(([r, m]) => ({
      tool: r, url: `${PUBLIC_URL}/x402/${r}`, price_usdc: m.price,
      amount: String(Math.round(m.price * 1e6)), description: m.desc, method: "POST",
    })),
  };
}
app.get("/x402", (req, res) => res.set("Access-Control-Allow-Origin", "*").json(discoveryIndex()));
app.get("/.well-known/x402", (req, res) => res.set("Access-Control-Allow-Origin", "*").json(discoveryIndex()));
app.get("/x402/:route", (req, res) => {
  const r = req.params.route;
  if (!ROUTES[r]) return res.status(404).json({ error: "unknown_resource", available: Object.keys(ROUTES) });
  const { paymentRequired } = require("./lib/x402");
  const challenge = Buffer.from(JSON.stringify(paymentRequired(r, ROUTES[r].price, ROUTES[r].desc))).toString("base64");
  res.set("PAYMENT-REQUIRED", challenge);
  res.set("WWW-Authenticate", 'x402 version="2"');
  res.set("Access-Control-Allow-Origin", "*");
  return res.status(402).json(paymentRequired(r, ROUTES[r].price, ROUTES[r].desc));
});

// ── REST tiers (thin wrappers over lib/handlers; x402-gated) ─────────────────
function restRoute(name, fn) {
  app.post(`/v1/${name}`, x402(name, ROUTES[name].price, ROUTES[name].desc), async (req, res) => {
    try {
      const out = await fn(req.body || {});
      res.json({ billing: req.billing, ...out });
    } catch (e) {
      const code = e.code === "bad_request" ? 400 : (e.status === 400 ? 400 : 502);
      res.status(code).json({ error: `${name}_error`, detail: String(e.message || e).slice(0, 300) });
    }
  });
}
restRoute("chat", handlers.doChat);
restRoute("analyze", handlers.doAnalyze);
restRoute("predict", handlers.doPredict);
restRoute("infer", handlers.doInfer);

// ── MCP transport (Streamable HTTP at /mcp) + machine-discovery cards ─────────
mountMcp(app);

const AGENT_CARD = {
  name: "FoundryNet Inference",
  description: "x402 LLM proxy + data-enriched analysis (17 sources) + predictive (IoT) intelligence.",
  url: `${PUBLIC_URL}/mcp`,
  transport: ["streamable-http"],
  tools: TOOLS,
  pricing: { model: "per-call", currency: "USDC", free_tier: false,
             rates: { chat: 0.02, analyze: 0.25, predict: 0.10, infer: 0.10 } },
  keywords: ["llm-proxy", "inference", "data-enrichment", "predictive-intelligence", "timesfm",
             "iot-inference", "machine-learning", "company-analysis", "equipment-prediction"],
  attestation: { enabled: true, protocol: "MINT Protocol" },
  network: { name: "FoundryNet Data Network", homepage: "https://foundrynet.io" },
  provider: { name: "FoundryNet", url: "https://foundrynet.io" },
};
const card = (req, res) => res.set("Access-Control-Allow-Origin", "*").set("Cache-Control", "public, max-age=300").json(AGENT_CARD);
app.get("/.well-known/mcp.json", card);
app.get("/agent-card.json", card);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`foundrynet-inference listening on :${PORT}`));

module.exports = app;
