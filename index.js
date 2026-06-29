"use strict";
/**
 * FoundryNet Inference — x402-gated revenue engine.
 *   Tier 1  POST /v1/chat     $0.02  generic LLM proxy (Claude)
 *   Tier 2  POST /v1/analyze  $0.25  data-enriched analysis (19 sources: 17 MCP servers + web search + scrape, + LLM)
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

// Point every response (esp. the 402 challenges) at the OpenAPI spec so x402scan
// can auto-discover it. RFC 8288 Link header, rel="describedby".
app.use((req, res, next) => {
  res.set("Link", '</openapi.json>; rel="describedby"');
  next();
});

const ROUTES = {
  chat: { price: 0.02, desc: "LLM inference proxy (Claude)" },
  analyze: { price: 0.25, desc: "Data-enriched analysis across the FoundryNet network (17 servers + live web search + page extraction) + LLM" },
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

// ── OpenAPI discovery doc (x402scan requires a spec at a discoverable URL) ────
// Schemas mirror lib/handlers exactly: chat→messages, analyze→query,
// predict→{values,threshold} (canonical_field/oem/direction optional), infer→telemetry.
function openApiDoc() {
  return {
    openapi: "3.1.0",
    info: {
      title: "FoundryNet Inference",
      description: "LLM inference proxy + data-enriched analysis + predictive intelligence. 19 data sources (17 MCP servers + live web search + page extraction). MINT-attested outputs. x402-gated (Solana/Base USDC); an fnet_ Forge key bypasses.",
      version: "1.0.0",
      contact: { email: "foundrynet@proton.me" },
    },
    servers: [{ url: PUBLIC_URL }],
    paths: {
      "/v1/chat": {
        post: {
          operationId: "chat",
          summary: "LLM inference proxy (Claude)",
          "x-x402-price": "$0.02",
          requestBody: {
            required: true,
            content: { "application/json": { schema: {
              type: "object",
              properties: {
                model: { type: "string", default: "claude-sonnet-4-6", description: "LLM model to use" },
                messages: { type: "array", description: "Chat messages array",
                  items: { type: "object", properties: { role: { type: "string" }, content: { type: "string" } }, required: ["role", "content"] } },
                system: { type: "string", description: "Optional system prompt" },
                max_tokens: { type: "integer", description: "Optional max output tokens" },
              },
              required: ["messages"],
            } } },
          },
          responses: { "200": { description: "LLM response" }, "402": { description: "Payment required — x402 challenge" } },
        },
      },
      "/v1/analyze": {
        post: {
          operationId: "analyze",
          summary: "Data-enriched analysis across the FoundryNet network + LLM synthesis",
          "x-x402-price": "$0.25",
          requestBody: {
            required: true,
            content: { "application/json": { schema: {
              type: "object",
              properties: {
                query: { type: "string", description: "Analysis query, e.g. 'NVDA risk profile'" },
                model: { type: "string", description: "Optional synthesis model" },
              },
              required: ["query"],
            } } },
          },
          responses: { "200": { description: "Scored analysis with key findings" }, "402": { description: "Payment required — x402 challenge" } },
        },
      },
      "/v1/predict": {
        post: {
          operationId: "predict",
          summary: "TimesFM predictive intelligence — threshold-breach forecasting",
          "x-x402-price": "$0.10",
          requestBody: {
            required: true,
            content: { "application/json": { schema: {
              type: "object",
              properties: {
                values: { type: "array", items: { type: "number" }, description: "Time series values (16+ recommended for a reliable forecast)" },
                threshold: { type: "number", description: "Breach threshold" },
                canonical_field: { type: "string", description: "Optional field name (e.g. spindle_load_pct); with `oem` it enables canonical normalization" },
                oem: { type: "string", description: "Optional equipment manufacturer (enables field normalization)" },
                direction: { type: "string", enum: ["above", "below"], default: "above" },
              },
              required: ["values", "threshold"],
            } } },
          },
          responses: { "200": { description: "Breach prediction + NL recommendation + MINT attestation" }, "402": { description: "Payment required — x402 challenge" } },
        },
      },
      "/v1/infer": {
        post: {
          operationId: "infer",
          summary: "IoT telemetry inference — normalize + forecast + anomaly detection",
          "x-x402-price": "$0.10",
          requestBody: {
            required: true,
            content: { "application/json": { schema: {
              type: "object",
              properties: {
                telemetry: { type: "object", description: "Key-value sensor readings; values may be scalars or numeric arrays (a 12+ point array enables forecasting)", additionalProperties: true },
                oem: { type: "string", description: "Equipment manufacturer (optional; enables normalization)" },
              },
              required: ["telemetry"],
            } } },
          },
          responses: { "200": { description: "Normalized telemetry with forecasts and anomaly flags" }, "402": { description: "Payment required — x402 challenge" } },
        },
      },
    },
  };
}
app.get("/openapi.json", (req, res) =>
  res.set("Access-Control-Allow-Origin", "*").set("Cache-Control", "public, max-age=300").json(openApiDoc()));

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

// ── okf-reliability-v1 self-prove endpoint (#2964) ──
app.get("/v1/reliability", (req, res) => {
  const okf = require("./lib/okf_reliability");
  let conformance;
  try {
    const V = require("./lib/verify_reliability");
    const vectors = require("./lib/conformance-vectors.json").vectors;
    let passed = 0;
    for (const v of vectors) {
      const r = V.check(v.reliability);
      const got = r.every((x) => x.pass) ? "valid" : "invalid";
      if (got === v.expect) passed++;
    }
    conformance = { passed, total: vectors.length, green: passed === vectors.length };
  } catch (e) { conformance = { error: String(e).slice(0, 120) }; }
  const ex = okf.forAttestedAnalysis({ asOf: new Date().toISOString(), score: 0.7 });
  res.set("Access-Control-Allow-Origin", "*").json({
    spec: "okf-reliability-v1", schema: okf.SCHEMA_URL, server: "inference",
    emits_meta_on: "every MCP tool result (_meta.reliability + integrity)",
    reference_example: { reliability: ex }, conformance,
    specification: "modelcontextprotocol#2964",
    reference_packet: "https://github.com/dynamicfeed/df-verify"
  });
});

app.get("/.well-known/mcp.json", card);
app.get("/agent-card.json", card);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`foundrynet-inference listening on :${PORT}`));

module.exports = app;
