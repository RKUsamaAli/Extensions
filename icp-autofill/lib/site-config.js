// Turns the server's CitaMate site config (bootstrap.siteConfig) into what content.js uses:
// every { source, flags } object becomes a RegExp. Returns null-safe errors: hydrate() throws
// when a required key is missing, so the content script stays locked instead of half-working.
// Loads as a classic content script (sets globalThis.CM_SITE) and as a CommonJS module in tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.CM_SITE = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const isRegexSpec = (v) => !!v && typeof v === "object" && !Array.isArray(v) && typeof v.source === "string";

  function toRegExp(spec, path) {
    try {
      return new RegExp(spec.source, spec.flags || "");
    } catch (err) {
      throw new Error("Site config: bad pattern at " + path + " (" + err.message + ")");
    }
  }

  function walk(v, path) {
    if (isRegexSpec(v)) return toRegExp(v, path);
    if (Array.isArray(v)) return v.map((x, i) => walk(x, path + "[" + i + "]"));
    if (v && typeof v === "object") {
      const out = {};
      for (const [k, x] of Object.entries(v)) out[k] = walk(x, path ? path + "." + k : k);
      return out;
    }
    return v;
  }

  // [path, check] – everything content.js reads.
  const str = (v) => typeof v === "string" && v.trim() !== "";
  const strList = (v) => Array.isArray(v) && v.length > 0 && v.every(str);
  const re = (v) => v instanceof RegExp;
  const REQUIRED = [
    ["selectors.provinceSelect", str],
    ["selectors.docBox", strList],
    ["selectors.name", strList],
    ["selectors.birthYear", strList],
    ["selectors.nationality", str],
    ["selectors.office", str],
    ["selectors.phone", strList],
    ["selectors.email", strList],
    ["selectors.next", strList],
    ["selectors.confirm", str],
    ["selectors.slots", str],
    ["selectors.stepButtonCandidates", str],
    ["selectors.captchaWidget", str],
    ["selectors.captchaResponse", str],
    ["selectors.captchaImageBox", strList],
    ["selectors.messageBoxes", strList],
    ["patterns.provinceName", re],
    ["patterns.tramiteName", re],
    ["patterns.tramiteExclude", re],
    ["patterns.bookedText", re],
    ["patterns.officePlaceholder", re],
    ["officeExcludeValues", (v) => Array.isArray(v) && v.every((x) => typeof x === "string")],
    ["stepButtons", (v) => !!v && typeof v === "object" && Object.keys(v).length > 0],
    ["urlPages", (v) => Array.isArray(v) && v.every((p) => p && re(p.pattern) && str(p.page))],
    ["knownMessages", (v) => Array.isArray(v) && v.every((m) => m && re(m.pattern) && str(m.label))],
  ];

  const get = (obj, path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

  /** @param {object} raw bootstrap.siteConfig  @returns hydrated config (RegExps) – throws when unusable */
  function hydrate(raw) {
    if (!raw || typeof raw !== "object" || !Object.keys(raw).length) throw new Error("The server has no CitaMate page settings yet.");
    const cfg = walk(raw, "");
    const bad = REQUIRED.filter(([p, ok]) => !ok(get(cfg, p))).map(([p]) => p);
    for (const [name, spec] of Object.entries(cfg.stepButtons || {})) {
      if (!strList(spec && spec.ids) || !re(spec && spec.text)) bad.push("stepButtons." + name);
      if (spec && spec.fallback && (!re(spec.fallback.path) || !strList(spec.fallback.ids))) bad.push("stepButtons." + name + ".fallback");
    }
    if (bad.length) throw new Error("CitaMate page settings from the server are incomplete: " + bad.join(", "));
    return cfg;
  }

  return { hydrate, REQUIRED: REQUIRED.map(([p]) => p) };
});
