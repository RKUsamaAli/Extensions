// Entries tab. Data comes from the CitaMate server (window.CM, see app.js); every change is
// saved through the service worker and comes back via CM.on.
window.CM.ready.then(() => {
  "use strict";
  const { el, ago, belongs } = window.CF;
  const { TEXT_FIELDS, SELECT_FIELDS } = window.CM_ENTRY;
  const CM = window.CM;
  const $ = (id) => document.getElementById(id);
  let entries = CM.data.entries;
  let logs = CM.data.logs;

  const PROVINCES = window.ICP_PROVINCES || [];
  const PAISES = window.ICP_PAISES || [];
  const TRAMITES = window.ICP_TRAMITES || {};
  const OFFICES = window.ICP_OFFICES || {};

  // ---------- dropdowns ----------
  function fillOptions(sel, list, placeholder) {
    sel.textContent = "";
    sel.append(el("option", { value: "", text: placeholder }));
    list.forEach((o) => sel.append(el("option", { value: o.value, text: o.text })));
  }

  function refreshProvinceLists(keepTramite, keepOffice) {
    const p = $("province").value;
    const tramites = p ? TRAMITES[p] || [] : [];
    const offices = p ? (OFFICES[p] || []).filter((o) => o.value !== "99") : [];
    fillOptions($("tramite"), tramites, p ? (tramites.length ? "— Not set —" : "— None in catalog —") : "— Pick province first —");
    fillOptions($("office"), offices, p ? "Any office (choose on page)" : "— Pick province first —");
    if (keepTramite) $("tramite").value = keepTramite;
    if (keepOffice) $("office").value = keepOffice;
  }

  fillOptions($("nationality"), PAISES, "— Not set —");
  fillOptions($("province"), PROVINCES, "— Not set —");
  refreshProvinceLists();
  $("province").addEventListener("change", () => refreshProvinceLists());

  const selText = (sel) => (sel.value && sel.selectedOptions[0] ? sel.selectedOptions[0].textContent : "");

  // ---------- server ----------
  const clean = (raw) => window.CM_ENTRY.clean(raw, PAISES);
  // Runs a CM call; shows the server's message (e.g. "Can't reach the server") on failure.
  async function act(fn, where) {
    try {
      return await fn();
    } catch (err) {
      const msg = (err && err.message) || "Something went wrong.";
      if (where) where.textContent = msg;
      else alert(msg);
      return null;
    }
  }

  // ---------- drawer form ----------
  function openDrawer(entry) {
    $("entryForm").reset();
    $("id").value = "";
    $("quickResult").hidden = true;
    if (entry) {
      $("id").value = entry.id;
      TEXT_FIELDS.forEach((f) => ($(f).value = entry[f] || ""));
      $("nationality").value = entry.nationality || "";
      $("province").value = entry.province || "";
      refreshProvinceLists(entry.tramite, entry.office);
    } else {
      refreshProvinceLists();
    }
    $("formTitle").textContent = entry ? "Edit entry" : "New entry";
    $("btnSave").textContent = entry ? "Save changes" : "Save entry";
    $("drawer").hidden = false;
    $("drawerBg").hidden = false;
    setTimeout(() => $("label").focus(), 0);
  }

  function closeDrawer() {
    $("drawer").hidden = true;
    $("drawerBg").hidden = true;
  }

  $("btnNew").addEventListener("click", () => openDrawer(null));
  $("btnNewEmpty").addEventListener("click", () => openDrawer(null));
  $("btnClose").addEventListener("click", closeDrawer);
  $("btnCancel").addEventListener("click", closeDrawer);
  $("drawerBg").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !$("drawer").hidden) closeDrawer();
  });

  $("entryForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const raw = {};
    TEXT_FIELDS.forEach((f) => (raw[f] = $(f).value));
    SELECT_FIELDS.forEach((f) => {
      raw[f] = $(f).value;
      raw[f + "Text"] = selText($(f));
    });
    const e = clean(raw);
    const miss = window.CM_ENTRY.missing(e);
    if (miss.length) return ($("formMsg").textContent = "Required: " + miss.join(", "));
    $("formMsg").textContent = "Saving…";
    $("btnSave").disabled = true;
    const r = await act(() => CM.send("CM_SAVE_ENTRY", { entry: e, id: $("id").value || "" }), $("formMsg"));
    $("btnSave").disabled = false;
    if (!r) return;
    $("formMsg").textContent = "";
    closeDrawer();
  });

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
        el("button", { class: "ghost", text: "Edit", onclick: () => openDrawer(e) }),
        el("button", { class: "ghost", text: "Report & logs", onclick: () => (location.hash = "records/entry/" + e.id) }),
        el("span", { class: "spacer" }),
        el("button", {
          class: "ghost",
          text: "Duplicate",
          onclick: () => act(() => CM.send("CM_SAVE_ENTRY", { entry: clean({ ...e, label: e.label + " (copy)" }) })),
        }),
        el("button", {
          class: "ghost danger",
          text: "Delete",
          "data-testid": "entry-delete",
          onclick: () => {
            if (!confirm('Delete "' + e.label + '"? Its log history is kept.')) return;
            act(() => CM.send("CM_DELETE_ENTRY", { id: e.id }));
          },
        }),
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

  // ---------- quick fill (one colon-separated line) ----------
  function quickFill() {
    const line = $("quickLine").value.trim();
    const box = $("quickResult");
    if (!line) return;
    const r = window.CM_PASTE.parseLine(line);
    const e = r.entry;
    TEXT_FIELDS.forEach((f) => {
      if (e[f] != null && e[f] !== "") $(f).value = e[f];
    });
    if (e.nationality) $("nationality").value = e.nationality;
    if (e.province) {
      $("province").value = e.province;
      refreshProvinceLists(e.tramite, e.office);
    } else if (e.tramite || e.office) {
      r.warnings.push("Trámite/office need a province – pick it below");
    }
    const lines = [el("span", { class: "ok", text: r.filled.length ? "✓ Filled: " + r.filled.join(", ") : "Nothing recognised" })];
    if (r.unknown.length) lines.push(el("span", { class: "bad", text: "Not recognised: " + r.unknown.join(" · ") }));
    r.warnings.forEach((w) => lines.push(el("span", { class: "warn", text: "⚠ " + w })));
    box.replaceChildren(...lines);
    box.hidden = false;
  }
  $("btnQuick").addEventListener("click", quickFill);
  $("quickLine").addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      quickFill();
    }
  });
  $("quickLine").addEventListener("paste", () => setTimeout(quickFill, 0));

  // ---------- bulk add (one entry per line) ----------
  let bulk = null;

  function openBulk() {
    $("bulkDrawer").hidden = false;
    $("bulkBg").hidden = false;
    previewBulk();
    setTimeout(() => $("bulkText").focus(), 0);
  }
  function closeBulk() {
    $("bulkDrawer").hidden = true;
    $("bulkBg").hidden = true;
  }

  function previewBulk() {
    bulk = window.CM_PASTE.parseBulk($("bulkText").value, entries.map((e) => e.docNumber));
    const good = bulk.rows.filter((r) => r.ok);
    const bad = bulk.rows.length - good.length;
    const parts = [];
    if (good.length) parts.push(good.length + " ready");
    if (bad) parts.push(bad + " with problems (skipped)");
    if (bulk.duplicates) parts.push(bulk.duplicates + " duplicate" + (bulk.duplicates > 1 ? "s" : "") + " skipped");
    $("bulkSummary").textContent = $("bulkText").value.trim() ? parts.join(" · ") || "Nothing to add" : "";
    $("bulkRows").replaceChildren(
      ...bulk.rows.map((r) =>
        el(
          "tr",
          { class: r.ok ? null : "bad" },
          el("td", { text: String(r.line) }),
          el("td", { text: r.entry.label || "—" }),
          el("td", { text: r.entry.docNumber ? r.entry.docType + " " + r.entry.docNumber : "—" }),
          el("td", { text: r.entry.fullName || "—" }),
          el("td", { text: r.entry.provinceText || "—" }),
          el("td", { text: short(r.entry.tramiteText) || "—", title: r.entry.tramiteText || null }),
          el("td", { text: short(r.entry.officeText) || "—", title: r.entry.officeText || null }),
          el("td", {
            class: r.ok ? "" : "danger",
            text: [r.ok ? "OK" : "Skipped", ...r.warnings, r.unknown.length ? "Unknown: " + r.unknown.join(" · ") : ""].filter(Boolean).join(" – "),
          }),
        ),
      ),
    );
    $("bulkPreviewWrap").hidden = bulk.rows.length === 0;
    $("bulkAdd").disabled = good.length === 0;
    $("bulkAdd").textContent = good.length ? "Add " + good.length + " entr" + (good.length === 1 ? "y" : "ies") : "Add entries";
  }

  async function addBulk() {
    if (!bulk) return;
    const good = bulk.rows.filter((r) => r.ok);
    if (!good.length) return;
    $("bulkAdd").disabled = true;
    const r = await act(() => CM.send("CM_SAVE_ENTRIES_BULK", { items: good.map((x) => clean(x.entry)) }), $("bulkSummary"));
    $("bulkAdd").disabled = false;
    if (!r) return;
    $("bulkText").value = "";
    closeBulk();
    alert("Added " + r.items.length + " entr" + (r.items.length === 1 ? "y" : "ies") + ".");
  }

  $("btnBulk").addEventListener("click", openBulk);
  $("bulkClose").addEventListener("click", closeBulk);
  $("bulkCancel").addEventListener("click", closeBulk);
  $("bulkBg").addEventListener("click", closeBulk);
  $("bulkText").addEventListener("input", previewBulk);
  $("bulkAdd").addEventListener("click", addBulk);
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !$("bulkDrawer").hidden) closeBulk();
  });

  // ---------- import / export ----------
  $("btnExport").addEventListener("click", () => {
    // Entry fields only (no server ids/owners), so the file imports cleanly anywhere.
    const blob = new Blob([JSON.stringify(entries.map((e) => window.CM_ENTRY.body(e)), null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "citamate-entries.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  $("fileImport").addEventListener("change", async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data)) throw new Error("File must contain a list of entries");
      const items = data.map(clean).filter((e) => !window.CM_ENTRY.missing(e).length);
      const skipped = data.length - items.length;
      if (!items.length) throw new Error("No entries with a label, document number and name in this file");
      const r = await CM.send("CM_SAVE_ENTRIES_BULK", { items });
      alert("Imported " + r.items.length + " entries." + (skipped ? " Skipped " + skipped + " without label, document number or name." : ""));
    } catch (err) {
      alert("Import failed: " + err.message);
    }
    ev.target.value = "";
  });

  CM.on((keys) => {
    if (!keys.includes("entries") && !keys.includes("logs")) return;
    entries = CM.data.entries;
    logs = CM.data.logs;
    render();
  });

  render();
});
