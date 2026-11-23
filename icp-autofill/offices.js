// Records → Office availability, read from the CitaMate server (window.CM).
window.CM.ready.then(() => {
  "use strict";
  const CM = window.CM;
  const $ = (id) => document.getElementById(id);
  let checks = [];

  const fmt = (t) => new Date(t).toLocaleString([], { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const short = (s) => String(s || "").split(",")[0].trim();

  function filtered() {
    const p = $("offProvince").value;
    return checks.filter((c) => !p || c.province === p);
  }

  // One row per office: how often it was listed out of the checks for its province.
  function summary(list) {
    const checksPerProv = {};
    list.forEach((c) => (checksPerProv[c.province || "—"] = (checksPerProv[c.province || "—"] || 0) + 1));
    const map = new Map();
    list.forEach((c) =>
      (c.offices || []).forEach((o) => {
        const prov = c.province || "—";
        const k = prov + "|" + o.text;
        const row = map.get(k) || { office: o.text, province: prov, seen: 0, first: c.t, last: c.t };
        row.seen++;
        row.first = Math.min(row.first, c.t);
        row.last = Math.max(row.last, c.t);
        map.set(k, row);
      }),
    );
    return Array.from(map.values())
      .map((r) => ({ ...r, checks: checksPerProv[r.province] }))
      .sort((a, b) => b.last - a.last || b.seen - a.seen);
  }

  function td(text, title) {
    const el = document.createElement("td");
    el.textContent = text;
    if (title) el.title = title;
    return el;
  }

  function renderProvinceFilter() {
    const sel = $("offProvince");
    const keep = sel.value;
    const names = Array.from(new Set(checks.map((c) => c.province).filter(Boolean))).sort();
    sel.textContent = "";
    const all = document.createElement("option");
    all.value = "";
    all.textContent = "All provinces";
    sel.appendChild(all);
    names.forEach((n) => {
      const o = document.createElement("option");
      o.value = n;
      o.textContent = n;
      sel.appendChild(o);
    });
    sel.value = names.includes(keep) ? keep : "";
  }

  function render() {
    renderProvinceFilter();
    const list = filtered();
    const rows = summary(list);
    const body = $("offRows");
    body.textContent = "";
    rows.forEach((r) => {
      const tr = document.createElement("tr");
      tr.append(
        td(short(r.office), r.office),
        td(r.province),
        td(String(r.seen)),
        td(r.seen + " / " + r.checks + " (" + Math.round((r.seen / r.checks) * 100) + "%)"),
        td(fmt(r.last)),
        td(fmt(r.first)),
      );
      body.appendChild(tr);
    });
    const recent = $("offChecks");
    recent.textContent = "";
    list.slice(-100).reverse().forEach((c) => {
      const tr = document.createElement("tr");
      const names = (c.offices || []).map((o) => short(o.text));
      const cell = td(names.length ? names.length + ": " + names.join("; ") : "none");
      cell.className = "details";
      tr.append(td(fmt(c.t)), td(c.kind === "check" ? "Office check" : "Booking"), td(c.entry || "—"), td(c.province || "—"), td(short(c.tramite) || "—", c.tramite), cell);
      recent.appendChild(tr);
    });
    $("offCount").textContent = "(" + list.length + " checks, " + rows.length + " offices)";
    $("offEmpty").hidden = list.length > 0;
  }

  $("offProvince").addEventListener("change", render);

  $("btnOffCsv").addEventListener("click", () => {
    const esc = (v) => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
    const lines = [["Time", "Entry", "Province", "Trámite", "Office"].map(esc).join(",")];
    filtered().forEach((c) => {
      const offs = c.offices && c.offices.length ? c.offices : [{ text: "(none listed)" }];
      offs.forEach((o) => lines.push([fmt(c.t), c.entry, c.province, c.tramite, o.text].map(esc).join(",")));
    });
    const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "citamate-offices-" + new Date().toISOString().slice(0, 10) + ".csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  $("btnOffClear").addEventListener("click", () => {
    if (!confirm("Clear the office availability history? It is deleted from the server.")) return;
    CM.send("CM_CLEAR_SIGHTINGS").catch((err) => alert(err.message));
  });

  CM.on((keys) => {
    if (!keys.includes("sightings")) return;
    checks = CM.data.sightings;
    render();
  });

  checks = CM.data.sightings;
  render();
});
