// Entries tab (read-only). Data comes from the CitaMate server (window.CM, see app.js).
// Entries are added, edited and deleted in the web panel – the server refuses those changes
// from the extension – and show up here through CM.on.
window.CM.ready.then(() => {
  "use strict";
  const { el, ago, belongs } = window.CF;
  const CM = window.CM;
  const $ = (id) => document.getElementById(id);
  let entries = CM.data.entries;
  let logs = CM.data.logs;

  /** Web panel page where entries are managed (same account, already signed in there). */
  const panelUrl = () => String((CM.status && (CM.status.apiBase || CM.status.defaultApiBase)) || "").replace(/\/+$/, "") + "/app#entries";
  const openPanel = () => window.open(panelUrl(), "_blank", "noopener");
  $("btnManage").addEventListener("click", openPanel);
  $("btnManageEmpty").addEventListener("click", openPanel);

  // ---------- cards ----------
  const initials = (s) =>
    String(s || "?")
      .split(/[\s–-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0].toUpperCase())
      .join("");
  const short = (s) => String(s || "").split(",")[0].trim();

  function lastActivity(e) {
    for (let i = logs.length - 1; i >= 0; i--) if (belongs(logs[i], e)) return logs[i];
    return null;
  }

  function kv(label, value) {
    return [el("dt", { text: label }), el("dd", { class: value ? null : "unset", text: value || "not set", title: value || null })];
  }

  function card(e) {
    const last = lastActivity(e);
    const doc = { NIE: "NIE", DNI: "DNI", PASAPORTE: "Passport" }[e.docType] || e.docType;
    return el(
      "article",
      { class: "ecard", "data-testid": "entry-row", "data-entry-id": e.id },
      el(
        "div",
        { class: "ecard-top" },
        el("div", { class: "avatar", text: initials(e.label) }),
        el("div", { class: "ecard-title" }, el("b", { text: e.label, title: e.label }), el("span", { text: e.fullName })),
        el("span", { class: "doc", text: doc + " " + e.docNumber }),
        e.status === "in_progress" ? el("span", { class: "pill warn", text: "In progress", title: "Status set in the web panel" }) : null,
        e.officeOpen
          ? el("span", {
              class: "pill ok",
              "data-testid": "entry-office-open",
              text: "Office open · since " + new Date(e.officeOpen.since).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
              title: "Seen open: " + e.officeOpen.offices.join(", "),
            })
          : null,
      ),
      el(
        "dl",
        { class: "kv" },
        kv("Province", e.provinceText),
        kv("Trámite", e.tramiteText),
        kv("Office", e.officeText ? short(e.officeText) : e.province ? "Any office" : ""),
        kv("Contact", [e.phone, e.email].filter(Boolean).join(" · ")),
      ),
      el(
        "div",
        { class: "last" },
        last ? window.CF.pill(last.status) : el("span", { class: "pill info", text: "New" }),
        el("span", {
          text: last ? (last.page ? last.page + " · " : "") + last.detail + " · " + ago(last.t) : "No activity yet",
          title: last ? last.detail : null,
        }),
      ),
      el(
        "div",
        { class: "ecard-actions" },
        el("button", { class: "ghost", text: "Report & logs", onclick: () => (location.hash = "records/entry/" + e.id) }),
        el("span", { class: "spacer" }),
        el("button", { class: "ghost", text: "Edit ↗", title: "Edit in the web panel", "data-testid": "entry-edit-panel", onclick: openPanel }),
      ),
    );
  }

  function render() {
    const q = $("search").value.trim().toLowerCase();
    const list = entries.filter(
      (e) =>
        !q ||
        [e.label, e.fullName, e.docNumber, e.email, e.phone, e.provinceText, e.tramiteText, e.officeText].some((v) =>
          String(v || "").toLowerCase().includes(q),
        ),
    );
    $("cards").replaceChildren(...list.map(card));
    $("count").textContent = "(" + entries.length + ")";
    $("empty").hidden = entries.length > 0;
    if (entries.length && !list.length) $("cards").append(el("p", { class: "empty", text: "No entry matches “" + q + "”." }));
  }

  $("search").addEventListener("input", render);

  // ---------- export ----------
  $("btnExport").addEventListener("click", () => {
    // Entry fields only (no server ids/owners), so the file imports cleanly anywhere.
    const blob = new Blob([JSON.stringify(entries.map((e) => window.CM_ENTRY.body(e)), null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "citamate-entries.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  CM.on((keys) => {
    if (!keys.includes("entries") && !keys.includes("logs")) return;
    entries = CM.data.entries;
    logs = CM.data.logs;
    render();
  });

  render();
});
