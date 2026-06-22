"use strict";
/**
 * /v1/analyze pipeline: data-enriched analysis.
 *   1. Claude plans which FoundryNet server tools to query for the user's query.
 *   2. We execute those tool calls over MCP with the fleet fnet_ key (fail-open).
 *   3. Claude synthesizes the gathered context into an analysis.
 */

const anthropic = require("./anthropic");

const FORGE_KEY = process.env.FORGE_API_KEY || "";

// Catalog of entity-specific tools the planner may choose from (arg hints only).
const CATALOG = {
  "financial-signals": ["company_profile{ticker}", "insider_activity{ticker}", "earnings_check{ticker}", "institutional_moves{ticker}", "anomaly_alert{}", "sector_snapshot{sector}"],
  "market-data": ["quote{symbol}", "price_history{symbol}"],
  "patent-intel": ["company_patents{company}", "search_patents{query}", "prior_art_search{query}"],
  "cyber-intel": ["search_cve{keyword}", "vulnerability_scan{product,vendor}", "check_domain{domain}"],
  "compliance": ["search_regulations{query}", "enforcement_actions{company}", "recall_check{company}"],
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
  const sys = `You are a data-gathering planner for FoundryNet's intelligence network. Given a user query, pick the most relevant server tool calls to gather supporting data. Available tools (arg names in braces):\n${catalogStr}\n\nReturn ONLY a JSON array (max 6 items) of {"server","tool","args"} objects. Fill args with concrete values inferred from the query (tickers UPPERCASE, domains like nvidia.com, company names full). No prose.`;
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
  // Execute the planned tool calls concurrently, fail-open per call.
  const gathered = await Promise.all(plan.map(async (p) => {
    try {
      const data = await mcpCall(p.server, p.tool, p.args || {});
      return { server: p.server, tool: p.tool, args: p.args || {}, ok: !data.error, data };
    } catch (e) {
      return { server: p.server, tool: p.tool, args: p.args || {}, ok: false, data: { error: String(e).slice(0, 120) } };
    }
  }));
  const used = gathered.filter((g) => g.ok);
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
    sources_queried: gathered.map((g) => ({ server: g.server, tool: g.tool, ok: g.ok })),
    sources_used: used.length,
    model: final.model,
    cost_usd: +(planCost + final.cost_usd).toFixed(6),
  };
}

module.exports = { analyze, mcpCall };
