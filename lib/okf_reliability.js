"use strict";
/* okf-reliability-v1 emitter (JS) — conformant by construction; signed != verified.
   verified is NEVER true for self-attested output; sources is an INT; freshness not
   validity (matches okf-reliability-v1 + passes verify_reliability.js). #2964 */
const crypto = require("crypto");
const SCHEMA_URL = "https://dynamicfeed.ai/schemas/okf-reliability-v1.json";

function forAttestedAnalysis(opts) {
  opts = opts || {};
  const signed = !!opts.attestationHash;
  const obj = {
    type: "okf-reliability-v1",
    confidence: "MEDIUM",
    basis: opts.basis || "computed",
    sources: 1,
    verified: false,
    vantage: "producer-reported",
    signals: { signed: signed, corroborated: false, fresh: true }
  };
  const score = (opts.score == null) ? 0.7 : opts.score;
  obj.score = Math.max(0, Math.min(1, score));
  if (opts.asOf) obj.freshness = { as_of: opts.asOf, state: "fresh" };
  return obj;
}
function integrity(serverId, version, producedAt, outputText) {
  const o = { serverId: serverId, serverVersion: version || "1.0.0", producedAt: producedAt };
  if (outputText != null) o.outputSha256 = crypto.createHash("sha256").update(outputText).digest("hex");
  return o;
}
function mcpMeta(rel, opts) {
  opts = opts || {};
  return { "io.modelcontextprotocol/integrity": integrity(opts.serverId, opts.version, opts.producedAt, opts.outputText), "reliability": rel };
}
module.exports = { SCHEMA_URL, forAttestedAnalysis, integrity, mcpMeta };
