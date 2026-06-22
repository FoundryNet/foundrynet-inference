"use strict";
/**
 * Core logic for the 4 tiers, framework-agnostic (no req/res) so BOTH the REST
 * routes and the MCP tools call the same functions. Each returns a plain result
 * object or throws.
 */

const anthropic = require("./anthropic");
const enrich = require("./enrich");
const forge = require("./forge");

async function doChat({ model, messages, system, max_tokens }) {
  if (!messages) throw Object.assign(new Error("messages required"), { code: "bad_request" });
  const out = await anthropic.chat({ model, messages, system, max_tokens });
  return {
    model: out.model, text: out.text, usage: out.usage,
    cost_usd: out.cost_usd, billed_equivalent_usd: +(out.cost_usd * 1.15).toFixed(6),
    content: out.raw.content,
  };
}

async function doAnalyze({ query, model }) {
  if (!query) throw Object.assign(new Error("query required"), { code: "bad_request" });
  return enrich.analyze(String(query), model);
}

async function doPredict({ canonical_field, values, threshold, oem, direction }) {
  if (!Array.isArray(values) || values.length < 1) throw Object.assign(new Error("values (number[]) required"), { code: "bad_request" });
  if (typeof threshold !== "number") throw Object.assign(new Error("threshold (number) required"), { code: "bad_request" });
  let field = canonical_field;
  let normalized_field = canonical_field;
  if (oem && canonical_field) {
    const c = await forge.canonicalize(canonical_field, values[values.length - 1], oem);
    field = c.canonical_field; normalized_field = c.canonical_field;
  }
  const prediction = await forge.predictBreach({ time_series: values, threshold, canonical_field: field, direction });
  let recommendation = null;
  try {
    const rec = await anthropic.chat({ model: "claude-sonnet-4-6", max_tokens: 220,
      system: "You are a maintenance/ops advisor. Given a TimesFM threshold-breach prediction, give ONE concise, actionable recommendation (1-2 sentences). If will_breach is false, advise continued monitoring. Do not restate the raw numbers verbatim.",
      messages: [{ role: "user", content: `Field: ${normalized_field || field}. Prediction: ${JSON.stringify(prediction)}` }] });
    recommendation = rec.text.trim();
  } catch { /* optional */ }
  const attestation = await forge.attest({ field: normalized_field, prediction }, "analysis");
  return { prediction, recommendation, normalized_field: normalized_field || field, attestation };
}

function anomalyFlag(series) {
  if (!Array.isArray(series) || series.length < 4) return null;
  const mean = series.reduce((a, b) => a + b, 0) / series.length;
  const sd = Math.sqrt(series.reduce((a, b) => a + (b - mean) ** 2, 0) / series.length) || 1e-9;
  const z = (series[series.length - 1] - mean) / sd;
  return { latest: series[series.length - 1], mean: +mean.toFixed(4), zscore: +z.toFixed(2), anomaly: Math.abs(z) >= 2.5 };
}

async function doInfer({ telemetry, oem }) {
  if (!telemetry || typeof telemetry !== "object") throw Object.assign(new Error("telemetry object required"), { code: "bad_request" });
  const snapshot = {};
  for (const [k, v] of Object.entries(telemetry)) snapshot[k] = Array.isArray(v) ? v[v.length - 1] : v;
  let normalized = {};
  try { const n = await forge.normalize(snapshot, oem); normalized = n.normalized || {}; } catch { normalized = snapshot; }
  const fields = [];
  for (const [rawField, v] of Object.entries(telemetry)) {
    const series = Array.isArray(v) ? v : null;
    const canon = Object.keys(normalized).find((c) => normalized[c] === (series ? series[series.length - 1] : v)) || rawField;
    const entry = { field: rawField, canonical_field: canon, current: series ? series[series.length - 1] : v };
    if (series && series.length >= 12) {
      try {
        const fc = await forge.predict(series, canon, 24);
        entry.forecast = { point_forecast: (fc.point_forecast || []).slice(0, 12), horizon: fc.horizon };
      } catch (e) { entry.forecast_error = String(e.message || e).slice(0, 120); }
      entry.anomaly = anomalyFlag(series);
    }
    fields.push(entry);
  }
  const report = { oem: oem || null, fields_total: fields.length,
    fields_forecast: fields.filter((f) => f.forecast).length,
    anomalies: fields.filter((f) => f.anomaly && f.anomaly.anomaly).map((f) => f.canonical_field),
    fields };
  const attestation = await forge.attest(report, "analysis");
  return report.attestation ? report : { ...report, attestation };
}

module.exports = { doChat, doAnalyze, doPredict, doInfer };
