// Records → Activity log, read from the CitaMate server (window.CM).
window.CM.ready.then(() => {
  "use strict";
  const CM = window.CM;
  const $ = (id) => document.getElementById(id);
  const LABELS = { done: "Done", ok: "OK", fail: "Failed", stuck: "Stuck", wait: "Waiting", info: "Info", run: "Running" };
  let logs = [];

  const fmt = (t) => new Date(t).toLocaleString([], { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });

  function filtered() {
    const st = $("logStatus").value;
    const en = $("logEntry").value;
    const kind = $("logKind").value;
    const term = $("logSearch").value.trim().toLowerCase();
    return logs
      .filter((l) => (!st || l.status === st) && (!en || l.entry === en) && (!kind || (l.kind || "booking") === kind))
      .filter((l) => !term || [l.detail, l.page, l.action, l.entry, l.url].some((v) => String(v || "").toLowerCase().includes(term)))
      .slice()
      .reverse();
  }

  function renderStats() {
    const count = (s) => logs.filter((l) => l.status === s).length;
    const results = logs.filter((l) => l.action === "Result" || l.action === "Page");
    const stats = [
      ["Booked", count("done")],
      ["Pages moved", results.filter((l) => l.status === "ok").length],
      ["Failed", count("fail")],
      ["Stuck", count("stuck")],
      ["Captcha waits", count("wait")],
      ["Office checks", logs.filter((l) => l.kind === "check" && l.page === "Office" && l.action === "Office check" && !/^Stopped/.test(l.detail || "")).length],
    ];
    const box = $("logStats");
    box.textContent = "";
    stats.forEach(([name, n]) => {
      const d = document.createElement("div");
      d.className = "stat";
      const b = document.createElement("b");
      b.textContent = n;
      const s = document.createElement("span");
      s.textContent = name;
      d.append(b, s);
      box.appendChild(d);
    });
  }

  function renderEntryFilter() {
    const sel = $("logEntry");
    const keep = sel.value;
    const names = Array.from(new Set(logs.map((l) => l.entry).filter(Boolean))).sort();
    sel.textContent = "";
    const all = document.createElement("option");
    all.value = "";
    all.textContent = "All entries";
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
    renderStats();
    renderEntryFilter();
    const rows = filtered();
    const tbody = $("logRows");
    tbody.textContent = "";
    rows.slice(0, 500).forEach((l) => {
      const tr = document.createElement("tr");
      const cells = [fmt(l.t), null, l.kind === "check" ? "Office check" : "Booking", l.entry || "—", l.page || "—", l.action || "—", l.detail || ""];
      cells.forEach((v, i) => {
        const td = document.createElement("td");
        if (i === 1) {
          const pill = document.createElement("span");
          pill.className = "pill " + l.status;
          pill.textContent = LABELS[l.status] || l.status;
          td.appendChild(pill);
        } else td.textContent = v;
        if (i === 6) {
          td.className = "details";
          td.title = l.url || "";
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    $("logCount").textContent = "(" + logs.length + (rows.length !== logs.length ? ", " + rows.length + " shown" : "") + ")";
    $("logEmpty").hidden = rows.length > 0;
  }

  ["logStatus", "logEntry", "logKind"].forEach((id) => $(id).addEventListener("change", render));
  $("logSearch").addEventListener("input", render);

  $("btnLogCsv").addEventListener("click", () => {
    const esc = (v) => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
    const lines = [["Time", "Result", "Type", "Entry", "Page", "Action", "Details", "URL"].map(esc).join(",")];
    filtered().forEach((l) => lines.push([fmt(l.t), LABELS[l.status] || l.status, l.kind === "check" ? "Office check" : "Booking", l.entry, l.page, l.action, l.detail, l.url].map(esc).join(",")));
    const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "citamate-log-" + new Date().toISOString().slice(0, 10) + ".csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  $("btnLogClear").addEventListener("click", () => {
    if (!confirm("Clear your whole activity log? It is deleted from the server.")) return;
    CM.send("CM_CLEAR_LOGS").catch((err) => alert(err.message));
  });

  CM.on((keys) => {
    if (!keys.includes("logs")) return;
    logs = CM.data.logs;
    render();
  });

  logs = CM.data.logs;
  render();
});
