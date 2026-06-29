// SPDX-License-Identifier: MIT
// Reference validator for the OKF reliability object — JavaScript (zero-dependency, node + browser).
//
// Spec:   https://dynamicfeed.ai/schemas/okf-reliability-v1.json
// Origin: the reliability axis proposed in GoogleCloudPlatform/knowledge-catalog#151 and in-toto/attestation#554.
// Mirror of verify_reliability.py in this directory. The cardinal rule it enforces: SIGNED != VERIFIED,
// a signature proves integrity, not truth; `verified` is earned only by independent corroboration.
//
// Node:    node verify_reliability.js <file.json>   |   node verify_reliability.js --selftest
// Browser: window.DFReliability.validate(obj)  ->  { ok, results }
// Exit code 0 = valid, 1 = invalid (or self-test failure).
(function (root) {
  "use strict";
  var BANDS = ["HIGH", "MEDIUM", "LOW", "UNVERIFIED"];
  var BASES = ["live-source", "partner-attested", "vendor-doc", "forecast", "computed", "inferred"];
  var STATES = ["fresh", "stale", "unavailable"];
  var VANTAGES = ["independent", "producer-reported"];
  var has = function (a, v) { return a.indexOf(v) !== -1; };
  var isObj = function (v) { return v && typeof v === "object" && !Array.isArray(v); };

  function check(o) {
    var r = [];
    var ck = function (name, cond, detail) { r.push({ name: name, pass: !!cond, detail: detail || "" }); return !!cond; };
    if (!isObj(o)) return [{ name: "is-object", pass: false, detail: "reliability is not an object" }];

    var conf = o.confidence, basis = o.basis, score = o.score, sources = o.sources,
        verified = o.verified, signals = isObj(o.signals) ? o.signals : {},
        conflict = isObj(o.conflict) ? o.conflict : null, freshness = isObj(o.freshness) ? o.freshness : {};

    ck("confidence-band", has(BANDS, conf), "confidence=" + JSON.stringify(conf) + "; must be one of " + BANDS.join("|"));
    ck("basis-enum", has(BASES, basis), "basis=" + JSON.stringify(basis) + "; must be one of " + BASES.join("|"));

    if (score !== undefined && score !== null)
      ck("score-range", typeof score === "number" && score >= 0 && score <= 1, "score=" + JSON.stringify(score) + " must be 0..1");
    if (sources !== undefined && sources !== null)
      ck("sources-int", Number.isInteger(sources) && sources >= 0, "sources=" + JSON.stringify(sources) + " must be int >= 0");

    // honesty rule: verified:true => sources >= 2 (corroboration, not a signature)
    if (verified === true)
      ck("verified-needs-2-sources", Number.isInteger(sources) && sources >= 2, "verified=true but sources=" + JSON.stringify(sources) + " (must be >= 2)");

    // UNVERIFIED cannot be verified and cannot carry a high score
    if (conf === "UNVERIFIED") {
      ck("unverified-not-verified", verified !== true, "confidence=UNVERIFIED but verified=true");
      if (score !== undefined && score !== null)
        ck("unverified-low-score", score < 0.5, "confidence=UNVERIFIED but score=" + JSON.stringify(score) + " (must be < 0.5)");
    }
    // HIGH band cannot ride a near-zero computed score
    if (conf === "HIGH" && score !== undefined && score !== null)
      ck("high-coherent-score", score >= 0.5, "confidence=HIGH but score=" + JSON.stringify(score) + " (must be >= 0.5)");

    if (conflict) {
      var disputed = conflict.disputed;
      ck("conflict-disputed-bool", typeof disputed === "boolean", "conflict.disputed=" + JSON.stringify(disputed) + " must be bool");
      if (disputed === true) {
        ck("disputed-not-verified", verified !== true, "conflict.disputed=true but verified=true");
        // a dispute is a corroboration failure, so the band caps at MEDIUM (HIGH excluded); the prevailing
        // position may carry up to MEDIUM, or a conservative producer may floor to LOW.
        ck("disputed-band-capped", has(["MEDIUM", "LOW", "UNVERIFIED"], conf), "conflict.disputed=true but confidence=" + JSON.stringify(conf) + " (a dispute caps the band at MEDIUM; HIGH excluded)");
        var pos = conflict.positions;
        ck("disputed-two-positions", Array.isArray(pos) && pos.length >= 2, "conflict.disputed=true requires >= 2 positions");
        if (Array.isArray(pos)) pos.forEach(function (p, i) {
          ck("position[" + i + "]-shape", isObj(p) && !!p.statement && has(BASES, p.basis), "position " + i + " needs statement + valid basis");
        });
        ck("disputed-resolution", !!conflict.resolution, "conflict.disputed=true requires a resolution string");
      }
      if ("conflict" in signals && typeof disputed === "boolean")
        ck("signals-conflict-agrees", !!signals.conflict === disputed, "signals.conflict disagrees with conflict.disputed");
    }

    if (freshness.state !== undefined && freshness.state !== null)
      ck("freshness-state", has(STATES, freshness.state), "freshness.state=" + JSON.stringify(freshness.state) + " must be one of " + STATES.join("|"));

    if (o.vantage !== undefined && o.vantage !== null)
      ck("vantage-enum", has(VANTAGES, o.vantage), "vantage=" + JSON.stringify(o.vantage) + " must be one of " + VANTAGES.join("|"));

    return r;
  }

  function extract(doc) {
    if (isObj(doc)) {
      if ("confidence" in doc && "basis" in doc) return doc;
      if (isObj(doc.reliability)) return doc.reliability;
      if (Array.isArray(doc.facts) && doc.facts[0] && isObj(doc.facts[0].reliability)) return doc.facts[0].reliability;
    }
    return doc;
  }

  function validate(doc, log) {
    var results = check(extract(doc));
    var ok = results.every(function (x) { return x.pass; });
    if (log) {
      results.forEach(function (x) { log("  [" + (x.pass ? "ok  " : "FAIL") + "] " + x.name + (!x.pass && x.detail ? "  — " + x.detail : "")); });
      log((ok ? "VALID" : "INVALID") + "  (" + results.filter(function (x) { return x.pass; }).length + "/" + results.length + " invariants)");
    }
    return { ok: ok, results: results };
  }

  var GOOD = [
    { confidence: "MEDIUM", basis: "live-source", score: 0.8, sources: 1, verified: false, freshness: { state: "fresh" }, signals: { signed: true, corroborated: false, fresh: true } },
    { confidence: "HIGH", basis: "live-source", score: 0.95, sources: 3, verified: true, signals: { signed: true, corroborated: true, fresh: true } },
    { confidence: "LOW", basis: "live-source", sources: 2, verified: false, conflict: { disputed: true, resolution: "live prevails; both kept", positions: [{ statement: "42", basis: "live-source" }, { statement: "11", basis: "vendor-doc" }] }, signals: { conflict: true } },
    { confidence: "MEDIUM", basis: "live-source", sources: 2, verified: false, conflict: { disputed: true, resolution: "live-source prevails under the trust ordering; both kept", positions: [{ statement: "42", basis: "live-source" }, { statement: "11", basis: "vendor-doc" }] }, signals: { conflict: true } },
    { confidence: "LOW", basis: "inferred" }
  ];
  var BAD = [
    { confidence: "HIGH", basis: "live-source", score: 0.9, sources: 2, verified: false, conflict: { disputed: true, resolution: "x", positions: [{ statement: "a", basis: "live-source" }, { statement: "b", basis: "vendor-doc" }] }, signals: { conflict: true } },
    { confidence: "HIGH", basis: "live-source", verified: true, sources: 0, score: 0.9 },
    { confidence: "HIGH", basis: "live-source", score: 0.05 },
    { confidence: "UNVERIFIED", basis: "inferred", verified: true },
    { confidence: "LOW", basis: "live-source", conflict: { disputed: true } },
    { confidence: "LOW", basis: "live-source", verified: false, conflict: { disputed: true, resolution: "x", positions: [{ statement: "a", basis: "live-source" }, { statement: "b", basis: "vendor-doc" }] }, signals: { conflict: false } },
    { confidence: "PRETTY_SURE", basis: "live-source" }
  ];

  function selftest(log) {
    var ok = true;
    log("=== expect VALID ===");
    GOOD.forEach(function (g, i) { log("good[" + i + "]:"); if (!validate(g, log).ok) ok = false; });
    log("\n=== expect INVALID ===");
    BAD.forEach(function (b, i) { log("bad[" + i + "]:"); if (validate(b, log).ok) { ok = false; log("  !! should have been INVALID"); } });
    log("\nSELFTEST: " + (ok ? "PASS" : "FAIL"));
    return ok;
  }

  var api = { check: check, extract: extract, validate: validate, selftest: selftest };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.DFReliability = api;

  // CLI
  if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
    var log = function (s) { console.log(s); };
    var arg = process.argv[2];
    if (arg === "--selftest") process.exit(selftest(log) ? 0 : 1);
    else if (arg) { var doc = JSON.parse(require("fs").readFileSync(arg, "utf8")); process.exit(validate(doc, log).ok ? 0 : 1); }
    else { console.log("usage: node verify_reliability.js <file.json> | --selftest"); process.exit(2); }
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
