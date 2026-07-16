"use strict";
/**
 * /v1/analyze pipeline: data-enriched analysis.
 *   1. Claude plans which FoundryNet server tools to query for the user's query.
 *   2. We execute those tool calls over MCP with the fleet fnet_ key (fail-open).
 *   2b. In parallel: web search (when the query needs live web data) + page
 *       extraction (when the query references a URL), via the search/scrape
 *       gateways — folded in as invisible extra data sources.
 *   3. Claude synthesizes the gathered context into an analysis.
 */

const anthropic = require("./anthropic");

const FORGE_KEY = process.env.FORGE_API_KEY || "";

// Web backends (folded into analyze as additional, invisible data sources).
const SEARCH_URL = (process.env.SEARCH_URL || "https://foundrynet-search-production.up.railway.app").replace(/\/$/, "");
const SCRAPE_URL = (process.env.SCRAPE_URL || "https://foundrynet-scrape-production.up.railway.app").replace(/\/$/, "");

const URL_RE = /(https?:\/\/[^\s"'<>)\]]+)/i;
function extractUrl(q) { const m = String(q || "").match(URL_RE); return m ? m[1].replace(/[.,;]+$/, "") : null; }

// Heuristic: does this query likely benefit from live web results?
function queryNeedsWebData(q) {
  return /\b(latest|recent|news|today|current|right now|this (week|month|year)|20(2[4-9]|3\d)|trend|announce|update|happening|who is|what is|where is|how much|price of|when did|stock price|release|launch)\b/i.test(String(q || ""));
}

/** POST JSON to a sibling REST gateway with the fleet fnet_ key (bypasses its x402). Fail-open → null. */
async function restCall(base, path, body, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const H = { "Content-Type": "application/json", Accept: "application/json" };
    if (FORGE_KEY) H["Authorization"] = `Bearer ${FORGE_KEY}`;
    const r = await fetch(base + path, { method: "POST", headers: H, body: JSON.stringify(body), signal: ctrl.signal });
    const j = await r.json().catch(() => null);
    if (!j || j.error || j.payment_required || j.status === 402) return null;
    return j;
  } catch { return null; }
  finally { clearTimeout(to); }
}

/** Web search backend → a gathered-source entry, or null. */
async function webSearchSource(query) {
  const sr = await restCall(SEARCH_URL, "/v1/search", { query, max_results: 6 });
  const results = sr && Array.isArray(sr.results) ? sr.results.slice(0, 6) : null;
  if (!results || !results.length) return null;
  return { server: "foundrynet-search", tool: "search", args: { query }, ok: true, data: { results } };
}

/** Scrape backend for a URL referenced in the query → a gathered-source entry, or null. */
async function scrapeSource(url) {
  const ex = await restCall(SCRAPE_URL, "/v1/extract", { url, format: "text" });
  const text = ex && (ex.content || ex.text);
  if (!text) return null;
  return { server: "foundrynet-scrape", tool: "extract", args: { url },
           ok: true, data: { url: ex.url || url, title: ex.title, content: String(text).slice(0, 4000) } };
}

// Catalog of entity-specific tools the planner may choose from (arg hints only).
// Fix #4 — arg names below are the REAL server signatures (verified against the live
// servers). Previously market-data used {symbol} (server wants {ticker} → "missing
// required field") and compliance used {query} (server wants {keyword} → "unexpected
// keyword argument"), so macro/rates/crypto queries got no data. Added macro_dashboard
// and crypto-intel so Fed/inflation/BTC questions hit real sources instead of the
// equity-only sector_snapshot (which returns "no data for this sector yet" for macro/crypto).
const CATALOG = {
  "financial-signals": ["company_profile{ticker}", "insider_activity{ticker}", "earnings_check{ticker}", "institutional_moves{}", "anomaly_alert{}", "macro_dashboard{}", "sector_snapshot{sector}"],
  "market-data": ["quote{ticker}", "price_history{ticker}"],
  "crypto-intel": ["market_overview{}", "defi_overview{}"],
  "patent-intel": ["company_patents{company}", "search_patents{query}", "prior_art_search{query}"],
  "cyber-intel": ["search_cve{keyword}", "vulnerability_scan{product,vendor}", "check_domain{domain}"],
  "compliance": ["search_regulations{keyword}", "enforcement_actions{company}", "recall_check{company}"],
  "brand-intel": ["domain_profile{domain}", "tech_stack{domain}"],
};

function serverUrl(slug) {
  return `https://${slug}-mcp-production.up.railway.app/mcp`;
}

/** Call a sibling server's MCP tool with the fleet bearer (bypasses its x402). */
async function mcpCall(server, tool, args) {
  const base = serverUrl(server);
  const H = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  if (FORGE_KEY) H["Authorization"] = `Bearer ${FORGE_KEY}`;
  const parse = (txt) => {
    for (const line of txt.split("\n")) if (line.startsWith("data:")) return JSON.parse(line.slice(5).trim());
    return txt.trim().startsWith("{") ? JSON.parse(txt) : null;
  };
  const init = await fetch(base, { method: "POST", headers: H, body: JSON.stringify({
    jsonrpc: "2.0", id: "init", method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "fnet-inference", version: "1.0" } } }) });
  const sid = init.headers.get("mcp-session-id");
  const H2 = sid ? { ...H, "mcp-session-id": sid } : H;
  await fetch(base, { method: "POST", headers: H2, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  const call = await fetch(base, { method: "POST", headers: H2, body: JSON.stringify({
    jsonrpc: "2.0", id: "call", method: "tools/call", params: { name: tool, arguments: args || {} } }) });
  const data = parse(await call.text()) || {};
  const content = data.result && data.result.content;
  if (Array.isArray(content) && content[0] && content[0].type === "text") {
    try { return JSON.parse(content[0].text); } catch { return { text: content[0].text }; }
  }
  if (data.error) return { error: data.error };
  return data.result || { error: "no_result" };
}

async function planQueries(query) {
  const catalogStr = Object.entries(CATALOG).map(([s, t]) => `  ${s}: ${t.join(", ")}`).join("\n");
  const sys = `You are a data-gathering planner for FoundryNet's intelligence network. Given a user query, pick the most relevant server tool calls to gather supporting data. Available tools (arg names in braces):\n${catalogStr}\n\nReturn ONLY a JSON array (max 6 items) of {"server","tool","args"} objects. Fill args with concrete values inferred from the query (tickers UPPERCASE, domains like nvidia.com, company names full). For macro / interest-rate / inflation / Fed questions use financial-signals.macro_dashboard{} and compliance.search_regulations{keyword}; for crypto / Bitcoin questions use crypto-intel.market_overview{}; do NOT use sector_snapshot for macro or crypto (it only covers equity sectors). No prose.`;
  try {
    const out = await anthropic.chat({ model: "claude-sonnet-4-6", system: sys,
      messages: [{ role: "user", content: query }], max_tokens: 700 });
    const m = out.text.match(/\[[\s\S]*\]/);
    const plan = m ? JSON.parse(m[0]) : [];
    return { plan: Array.isArray(plan) ? plan.slice(0, 6) : [], cost_usd: out.cost_usd };
  } catch {
    return { plan: [], cost_usd: 0 };
  }
}

async function analyze(query, model) {
  const { plan, cost_usd: planCost } = await planQueries(query);

  // Web-backend tasks run in parallel with the MCP plan execution (fail-open).
  const needWeb = queryNeedsWebData(query);
  const refUrl = extractUrl(query);
  const webTask = needWeb ? webSearchSource(query) : Promise.resolve(null);
  const scrapeTask = refUrl ? scrapeSource(refUrl) : Promise.resolve(null);

  // Execute the planned tool calls concurrently, fail-open per call.
  const gatherTask = Promise.all(plan.map(async (p) => {
    try {
      const data = await mcpCall(p.server, p.tool, p.args || {});
      return { server: p.server, tool: p.tool, args: p.args || {}, ok: !data.error, data };
    } catch (e) {
      return { server: p.server, tool: p.tool, args: p.args || {}, ok: false, data: { error: String(e).slice(0, 120) } };
    }
  }));

  const [gathered, webSrc, scrapeSrc] = await Promise.all([gatherTask, webTask, scrapeTask]);
  const extras = [webSrc, scrapeSrc].filter(Boolean);
  const used = [...gathered.filter((g) => g.ok), ...extras];
  const context = JSON.stringify(used.map((g) => ({ source: `${g.server}.${g.tool}`, data: g.data })), null, 0).slice(0, 24000);

  const sys = "You are FoundryNet's analyst. Produce a rigorous, well-structured analysis grounded ONLY in the provided data sources. Cite which source each claim comes from. If a relevant source is missing, say so. Do not fabricate numbers.";
  const final = await anthropic.chat({
    model: model || "claude-sonnet-4-6",
    system: sys,
    max_tokens: 1500,
    messages: [{ role: "user", content: `Query: ${query}\n\nGathered data from FoundryNet servers:\n${context || "(no data returned)"}\n\nWrite the analysis.` }],
  });

  return {
    query,
    analysis: final.text,
    sources_queried: [...gathered, ...extras].map((g) => ({ server: g.server, tool: g.tool, ok: g.ok })),
    sources_used: used.length,
    model: final.model,
    cost_usd: +(planCost + final.cost_usd).toFixed(6),
  };
}

module.exports = { analyze, mcpCall };
