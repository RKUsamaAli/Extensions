// Helpers shared by the entries / records pages.
(() => {
  "use strict";
  const LABELS = { done: "Done", ok: "OK", fail: "Failed", stuck: "Stuck", wait: "Waiting", info: "Info", run: "Running" };

  const fmt = (t) =>
    new Date(t).toLocaleString([], { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });

  function ago(t) {
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return "just now";
    const m = Math.round(s / 60);
    if (m < 60) return m + " min ago";
    const h = Math.round(m / 60);
    if (h < 24) return h + " h ago";
    const d = Math.round(h / 24);
    return d < 30 ? d + " d ago" : new Date(t).toLocaleDateString();
  }

  // A log or office sighting belongs to an entry by id; older records only have the label.
  const belongs = (rec, entry) => !!entry && (rec.entryId ? rec.entryId === entry.id : rec.entry === entry.label);

  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === "class") n.className = v;
        else if (k === "text") n.textContent = v;
        else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
        else n.setAttribute(k, v === true ? "" : v);
      }
    }
    kids.flat().forEach((c) => c != null && n.append(c));
    return n;
  }

  const pill = (status) => el("span", { class: "pill " + status, text: LABELS[status] || status });

  function downloadCsv(name, header, rows) {
    const esc = (v) => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
    const lines = [header.map(esc).join(",")].concat(rows.map((r) => r.map(esc).join(",")));
    const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  const kindLabel = (k) => (k === "check" ? "Office check" : "Booking");

  window.CF = { LABELS, fmt, ago, belongs, el, pill, downloadCsv, kindLabel };
})();
