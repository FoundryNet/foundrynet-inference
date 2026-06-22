"use strict";
/**
 * MCP (Model Context Protocol) transport for foundrynet-inference — a thin layer
 * that exposes the 4 tiers as MCP tools over Streamable HTTP, so Smithery/Glama and
 * every MCP registry can list it alongside the data servers. Tools wrap the SAME
 * handlers as the REST routes; x402 gating lives inside each tool (fnet_ key
 * bypasses; otherwise the tool returns a payment_required object pointing at the
 * x402 REST flow). Stateless (per-request server+transport) — the scannable pattern.
 *
 * (Node uses the official MCP TypeScript SDK; FastMCP is Python-only. Same protocol.)
 */

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = require("zod");

const handlers = require("./handlers");
const { gateForMcp } = require("./x402");

const PRICES = { chat: 0.02, analyze: 0.25, predict: 0.10, infer: 0.10 };
const DESCS = {
  chat: "LLM inference proxy (Claude). $0.02/call.",
  analyze: "Data-enriched analysis across the FoundryNet network (17 sources) + LLM. $0.25/call.",
  predict: "TimesFM predictive intelligence — threshold-breach forecast + recommendation + MINT attestation. $0.10/call.",
  infer: "IoT telemetry inference — normalize + forecast + anomaly flags. $0.10/call.",
};

function bearerFrom(extra) {
  // Best-effort: pull an Authorization bearer from the request info the SDK passes.
  try {
    const h = (extra && extra.requestInfo && extra.requestInfo.headers) || {};
    const a = h.authorization || h.Authorization || "";
    return a.toLowerCase().startsWith("bearer ") ? a.slice(7).trim() : null;
  } catch { return null; }
}

function wrap(route, fn) {
  return async (args, extra) => {
    const apiKey = args.api_key || bearerFrom(extra);
    const gate = gateForMcp(route, PRICES[route], DESCS[route], apiKey);
    if (!gate.paid) return { content: [{ type: "text", text: JSON.stringify(gate.payment_required) }] };
    try {
      const result = await fn(args);
      return { content: [{ type: "text", text: JSON.stringify({ billing: gate.billing, ...result }) }] };
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ error: e.code || "error", detail: String(e.message || e).slice(0, 300) }) }], isError: true };
    }
  };
}

function buildServer() {
  const server = new McpServer({ name: "foundrynet-inference", version: "1.0.0" }, { capabilities: {} });

  server.registerTool("chat", { description: DESCS.chat, inputSchema: {
    prompt: z.string().optional().describe("Single user prompt (shortcut for messages)."),
    messages: z.array(z.any()).optional().describe("Anthropic-format messages array."),
    model: z.string().optional(), system: z.string().optional(), max_tokens: z.number().optional(),
    api_key: z.string().optional().describe("fnet_ Forge key to bypass payment."),
  } }, wrap("chat", (a) => handlers.doChat({ ...a, messages: a.messages || [{ role: "user", content: a.prompt || "" }] })));

  server.registerTool("analyze", { description: DESCS.analyze, inputSchema: {
    query: z.string().describe("What to analyze, e.g. 'Analyze NVDA risk profile'."),
    model: z.string().optional(), api_key: z.string().optional(),
  } }, wrap("analyze", (a) => handlers.doAnalyze(a)));

  server.registerTool("predict", { description: DESCS.predict, inputSchema: {
    values: z.array(z.number()).describe("Historical canonical values, oldest→newest (≥16 recommended)."),
    threshold: z.number().describe("Value to test for a crossing."),
    canonical_field: z.string().optional().describe("FCS field, e.g. 'spindle_load_pct'."),
    oem: z.string().optional().describe("OEM hint for normalization."),
    direction: z.string().optional().describe("'above' or 'below'."),
    api_key: z.string().optional(),
  } }, wrap("predict", (a) => handlers.doPredict(a)));

  server.registerTool("infer", { description: DESCS.infer, inputSchema: {
    telemetry: z.record(z.any()).describe("{ field: value | [series] } sensor readings."),
    oem: z.string().optional(), api_key: z.string().optional(),
  } }, wrap("infer", (a) => handlers.doInfer(a)));

  return server;
}

function mountMcp(app) {
  app.post("/mcp", async (req, res) => {
    try {
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => { transport.close(); server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  });
  const na = (_req, res) => res.writeHead(405).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }));
  app.get("/mcp", na);
  app.delete("/mcp", na);
}

const TOOLS = Object.keys(PRICES);
module.exports = { mountMcp, buildServer, TOOLS, PRICES, DESCS };
