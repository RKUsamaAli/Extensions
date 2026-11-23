// Page snapshot for failed / stuck autofill steps (CitaMate content script).
// It records the page STRUCTURE – which fields, buttons and messages are on it and which
// selectors were tried – so the site config (selectors / patterns) can be fixed from the
// panel's error export. It never records what is typed into fields (personal data).
(function (root) {
  "use strict";

  const MAX_FIELDS = 80;
  const MAX_BUTTONS = 40;
  const MAX_OPTIONS = 12;
  const clip = (s, n = 160) => {
    s = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  };
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);

  // Missing field name (as fillEntry reports it) -> site-config selector key.
  const FIELD_KEYS = {
    Document: "docBox",
    Name: "name",
    Year: "birthYear",
    Nationality: "nationality",
    Province: "provinceSelect",
    Office: "office",
    Phone: "phone",
    Email: "email",
  };

  function labelOf(el) {
    if (el.id) {
      try {
        const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (l) return clip(l.textContent, 120);
      } catch (_) {}
    }
    const wrap = el.closest("label");
    if (wrap) return clip(wrap.textContent, 120);
    return clip(el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("title") || "", 120);
  }

  function field(el) {
    const tag = el.tagName.toLowerCase();
    const out = {
      tag,
      type: tag === "input" ? (el.getAttribute("type") || "text").toLowerCase() : tag,
      id: el.id || "",
      name: el.getAttribute("name") || "",
      label: labelOf(el),
      visible: visible(el),
    };
    if (el.required) out.required = true;
    if (el.disabled) out.disabled = true;
    if (tag === "select") {
      const opts = [...el.options];
      out.optionCount = opts.length;
      out.options = opts.slice(0, MAX_OPTIONS).map((o) => clip(o.textContent, 80) + (o.value !== undefined ? " = " + clip(o.value, 40) : ""));
      out.selected = el.selectedIndex >= 0 && el.options[el.selectedIndex] ? clip(el.options[el.selectedIndex].textContent, 80) : "";
    } else if (out.type === "radio" || out.type === "checkbox") {
      out.value = clip(el.value, 40); // option value, not personal data
      out.checked = !!el.checked;
    } else {
      out.hasValue = !!String(el.value || "").trim(); // filled or not – never the value itself
    }
    return out;
  }

  function button(el) {
    const tag = el.tagName.toLowerCase();
    return {
      tag,
      type: (el.getAttribute("type") || "").toLowerCase(),
      id: el.id || "",
      name: el.getAttribute("name") || "",
      text: clip(tag === "input" ? el.value : el.textContent, 80),
      visible: visible(el),
    };
  }

  /**
   * take({ C, page, message, alert, fill, extra }) -> snapshot object
   *   C        hydrated site config (selectors, version)
   *   fill     { done: [...], missing: [...] } from fillEntry, if any
   */
  function take({ C, page, message, alert, fill, extra } = {}) {
    const sel = (C && C.selectors) || {};
    const missing = (fill && fill.missing) || [];
    const tried = missing.map((name) => {
      const key = FIELD_KEYS[name] || (name === "Trámite" ? "patterns.tramiteName" : "");
      const val = key && sel[key];
      return { field: name, configKey: key || "(code)", selectors: Array.isArray(val) ? val : val ? [String(val)] : [] };
    });
    const heading = document.querySelector("h1, h2, legend, .titulo, .mf-title");
    const fields = [...document.querySelectorAll("input, select, textarea")]
      .filter((el) => !["hidden", "submit", "button", "image", "reset"].includes((el.getAttribute("type") || "").toLowerCase()))
      .slice(0, MAX_FIELDS)
      .map(field);
    const buttons = [...document.querySelectorAll("button, input[type=submit], input[type=button], input[type=image], a.btn, a.mf-button")]
      .slice(0, MAX_BUTTONS)
      .map(button);
    const forms = [...document.forms].slice(0, 10).map((f) => ({ id: f.id || "", name: f.getAttribute("name") || "", action: clip(f.getAttribute("action") || "", 200) }));
    return {
      v: 1,
      page: page || "",
      url: location.pathname + location.search,
      title: clip(document.title, 200),
      heading: heading ? clip(heading.textContent, 200) : "",
      siteMessage: clip(message || "", 500),
      alert: clip(alert || "", 500),
      filled: (fill && fill.done) || [],
      missing,
      tried,
      fields,
      buttons,
      forms,
      configVersion: C && C.version != null ? C.version : null,
      extensionVersion: (root.chrome && chrome.runtime && chrome.runtime.getManifest && chrome.runtime.getManifest().version) || "",
      viewport: innerWidth + "x" + innerHeight,
      ...(extra || {}),
    };
  }

  root.CM_SNAPSHOT = { take, FIELD_KEYS };
})(typeof globalThis !== "undefined" ? globalThis : this);
