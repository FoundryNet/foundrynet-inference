"use strict";
/** Forge kernel client: normalize (FCS), TimesFM predict/predict_breach, + MINT attest. */

const crypto = require("crypto");

const FORGE = (process.env.FORGE_BASE_URL || "https://forge.foundrynet.io").replace(/\/$/, "");
const FORGE_KEY = process.env.FORGE_API_KEY || "";
const MINT = (process.env.MINT_BASE_URL || "https://mint-mcp-production.up.railway.app").replace(/\/$/, "");

function authHeaders() {
  const h = { "Content-Type": "application/json" };
  if (FORGE_KEY) h["Authorization"] = `Bearer ${FORGE_KEY}`;
  return h;
}

async function forgePost(path, body) {
  const r = await fetch(`${FORGE}${path}`, { method: "POST", headers: authHeaders(), body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(`forge ${path} ${r.status}: ${(j && (j.detail || j.error)) || JSON.stringify(j).slice(0, 200)}`);
    e.status = r.status;
    throw e;
  }
  return j;
}

/** Normalize a {field: value, ...} record to FCS canonical form (optionally OEM-hinted). */
async function normalize(data, oem) {
  const body = { data };
  if (oem) body.oem = oem;
  return forgePost("/v1/normalize", body);
}

/** Resolve one raw field name to its canonical FCS name via the normalizer. */
async function canonicalize(field, sampleValue, oem) {
  try {
    const res = await normalize({ [field]: sampleValue ?? 0 }, oem);
    const norm = res.normalized || {};
    const keys = Object.keys(norm);
    return { canonical_field: keys[0] || field, normalized: norm, coverage_pct: res.coverage_pct };
  } catch {
    return { canonical_field: field, normalized: { [field]: sampleValue }, coverage_pct: null };
  }
}

/** TimesFM point/quantile forecast. */
async function predict(time_series, canonical_field, horizon) {
  return forgePost("/v1/predict", { time_series, canonical_field, horizon: horizon || 24 });
}

/** TimesFM parametric breach prediction. */
async function predictBreach({ time_series, threshold, canonical_field, direction, horizon, mint_id, settle }) {
  const body = { time_series, threshold };
  if (canonical_field) body.canonical_field = canonical_field;
  if (direction) body.direction = direction;
  if (horizon) body.horizon = horizon;
  if (mint_id) body.mint_id = mint_id;
  if (settle) body.settle = settle;
  return forgePost("/v1/predict_breach", body);
}

// Lazy one-time MINT actor identity (register → scoped key + mint_id), cached.
const _mint = { ready: false, failed: false, mint_id: null, api_key: null };
async function _mintIdentity() {
  if (_mint.ready) return true;
  if (_mint.failed) return false;
  try {
    const headers = { "Content-Type": "application/json" };
    if (FORGE_KEY) headers["Authorization"] = `Bearer ${FORGE_KEY}`;
    const r = await fetch(`${MINT}/v1/register`, { method: "POST", headers,
      body: JSON.stringify({ name: "foundrynet-inference", actor_type: "service",
        capabilities: ["data_provenance", "attestation"] }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error || !j.mint_id) throw new Error("register failed");
    _mint.mint_id = j.mint_id;
    _mint.api_key = j.api_key || FORGE_KEY;
    _mint.ready = true;
    return true;
  } catch {
    _mint.failed = true;
    return false;
  }
}

/** Best-effort MINT attestation of a result payload. Never throws. */
async function attest(payload, workType) {
  const dataStr = JSON.stringify(payload);
  const output_hash = crypto.createHash("sha256").update(dataStr).digest("hex");
  const input_hash = crypto.createHash("sha256").update(dataStr.slice(0, 1000)).digest("hex");
  try {
    if (!(await _mintIdentity())) return { hash: output_hash, mint_verified: false, verify_at: `${MINT}/v1/verify` };
    const r = await fetch(`${MINT}/v1/attest`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${_mint.api_key}` },
      body: JSON.stringify({
        mint_id: _mint.mint_id,
        work_type: workType || "analysis",
        duration_seconds: 1,
        summary: "FoundryNet Inference predictive result",
        input_hash, output_hash,
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && !j.error && (j.attestation_id || j.tx_signature || j.data_hash)) {
      return { hash: j.data_hash || output_hash, mint_verified: true,
        attestation_id: j.attestation_id, tx_signature: j.tx_signature, verify_at: `${MINT}/v1/verify` };
    }
  } catch {
    /* fall through */
  }
  return { hash: output_hash, mint_verified: false, verify_at: `${MINT}/v1/verify` };
}

module.exports = { normalize, canonicalize, predict, predictBreach, attest, FORGE };
