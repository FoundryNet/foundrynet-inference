"use strict";
/** Minimal Anthropic Messages API client (fetch-based, no SDK dep). */

const API = "https://api.anthropic.com/v1/messages";
const KEY = process.env.ANTHROPIC_API_KEY || "";
const DEFAULT_MODEL = process.env.INFERENCE_DEFAULT_MODEL || "claude-sonnet-4-6";

// Per-1M-token USD pricing for margin accounting (cost + 15%). Approximate.
const PRICING = {
  "claude-opus-4-8": { in: 15, out: 75 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-haiku-4-5": { in: 1, out: 5 },
};

function costUsd(model, usage) {
  const p = PRICING[model] || PRICING[DEFAULT_MODEL];
  const i = (usage?.input_tokens || 0) / 1e6 * p.in;
  const o = (usage?.output_tokens || 0) / 1e6 * p.out;
  return +(i + o).toFixed(6);
}

/**
 * Call Claude. `messages` = Anthropic-format array; `system` optional.
 * Returns { text, model, usage, cost_usd, raw }.
 */
async function chat({ model, messages, system, max_tokens }) {
  if (!KEY) throw new Error("ANTHROPIC_API_KEY not configured");
  const useModel = (model && String(model)) || DEFAULT_MODEL;
  const body = {
    model: useModel,
    max_tokens: max_tokens || 1024,
    messages: Array.isArray(messages) ? messages : [{ role: "user", content: String(messages) }],
  };
  if (system) body.system = system;
  const r = await fetch(API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) {
    const detail = j?.error?.message || JSON.stringify(j).slice(0, 300);
    const e = new Error(`anthropic ${r.status}: ${detail}`);
    e.status = r.status;
    throw e;
  }
  const text = (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  return { text, model: useModel, usage: j.usage, cost_usd: costUsd(useModel, j.usage), raw: j };
}

module.exports = { chat, costUsd, DEFAULT_MODEL };
