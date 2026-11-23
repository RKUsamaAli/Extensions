// CitaMate entries (profiles).
import { get, post, put, del, qs } from "../api.js";
import { el, table, drawer, confirmDialog, toast, toastError, field, input, select, formValues, fmtTime, ago, downloadJson, pickFile } from "../ui.js";
import { ownerParam, ownerSelect, pageHead, showOwner, ownerField, ownerCell, defaultOwnerId, isAdmin } from "../state.js";

const DOC_TYPES = [{ value: "NIE", text: "NIE" }, { value: "DNI", text: "DNI" }, { value: "PASAPORTE", text: "Passport" }];
const TEXT_FIELDS = ["label", "docType", "docNumber", "fullName", "birthYear", "phone", "email", "notes"];
const SELECT_FIELDS = ["nationality", "province", "tramite", "office"];

let catalog = null;
async function loadCatalog() {
  if (!catalog) {
    try {
      catalog = (await get("/citamate/catalog")).data || {};
    } catch (e) {
      catalog = { provinces: [], paises: [], tramites: {}, offices: {} };
      if (e.code !== "no_entitlement" && e.code !== "subscription_expired") toastError(e);
    }
  }
  return catalog;
}

/** Keeps only the fields the API knows. */
function pick(raw) {
  const out = {};
  for (const f of TEXT_FIELDS) out[f] = String(raw[f] ?? "").trim();
  for (const f of SELECT_FIELDS) {
    out[f] = String(raw[f] ?? "").trim();
    out[f + "Text"] = String(raw[f + "Text"] ?? "").trim();
  }
  return out;
}

function opts(list, placeholder) {
  return [{ value: "", text: placeholder }].concat((list || []).map((o) => ({ value: o.value, text: o.text })));
}

async function openEditor(entry, onDone) {
  const cat = await loadCatalog();
  const e = entry || { docType: "NIE" };
  const selText = (s) => (s.value && s.selectedOptions[0] ? s.selectedOptions[0].textContent : "");
  // values missing from the catalog are kept as an extra option so nothing is lost on save
  const withCurrent = (list, value, text) =>
    value && !list.some((o) => o.value === value) ? list.concat([{ value, text: text || value }]) : list;

  const nationality = select("nationality", opts(withCurrent(cat.paises || [], e.nationality, e.nationalityText), "— Not set —"), e.nationality);
  const province = select("province", opts(withCurrent(cat.provinces || [], e.province, e.provinceText), "— Not set —"), e.province);
  const tramite = select("tramite", [], "");
  const office = select("office", [], "");
  function refreshProvince(keepT, keepO) {
    const p = province.value;
    const tl = withCurrent(p ? (cat.tramites || {})[p] || [] : [], keepT, e.tramiteText);
    const ol = withCurrent(p ? ((cat.offices || {})[p] || []).filter((o) => o.value !== "99") : [], keepO, e.officeText);
    tramite.textContent = "";
    opts(tl, p ? (tl.length ? "— Not set —" : "— None in catalog —") : "— Pick province first —").forEach((o) => tramite.append(el("option", { value: o.value }, o.text)));
    office.textContent = "";
    opts(ol, p ? "Any office (choose on page)" : "— Pick province first —").forEach((o) => office.append(el("option", { value: o.value }, o.text)));
    tramite.value = keepT || "";
    office.value = keepO || "";
  }
  refreshProvince(e.tramite, e.office);
  province.addEventListener("change", () => refreshProvince());

  const body = el(
    "div",
    { class: "form-grid" },
    ownerField(entry && entry.ownerId, "entry"),
    field("Status", select("status", ENTRY_STATUSES.map((x) => ({ value: x.id, text: x.label + (x.active ? " — shown in CitaMate" : "") })), (entry && entry.status) || "pending", { testid: "entry-status" }), { wide: true }),
    field("Label (shown in the CitaMate menu) *", input("label", e.label, { required: true, maxlength: 500, testid: "entry-label" }), { wide: true }),
    field("Document type", select("docType", DOC_TYPES, e.docType || "NIE", { testid: "entry-docType" })),
    field("Document number *", input("docNumber", e.docNumber, { required: true, autocapitalize: "characters", testid: "entry-docNumber" })),
    field("Full name (as on document) *", input("fullName", e.fullName, { required: true, testid: "entry-fullName" }), { wide: true }),
    field("Birth year", input("birthYear", e.birthYear, { inputmode: "numeric", maxlength: 4, testid: "entry-birthYear" })),
    field("Nationality", nationality),
    field("Province", province, { wide: true }),
    field("Trámite", tramite, { wide: true }),
    field("Office", office, { wide: true }),
    field("Phone", input("phone", e.phone, { type: "tel", testid: "entry-phone" })),
    field("Email", input("email", e.email, { type: "email", testid: "entry-email" })),
    field("Notes (only for you, never filled)", el("textarea", { name: "notes", rows: 3, testid: "entry-notes" }, e.notes || ""), { wide: true }),
  );
  [nationality, province, tramite, office].forEach((s) => s.setAttribute("data-testid", "entry-" + s.name));

  drawer({
    title: entry ? "Edit entry" : "New entry",
    body,
    testid: "entry-drawer",
    async onSave(form) {
      const v = formValues(form);
      v.nationalityText = selText(nationality);
      v.provinceText = selText(province);
      v.tramiteText = selText(tramite);
      v.officeText = selText(office);
      const missing = ["label", "docNumber", "fullName"].filter((k) => !String(v[k] || "").trim());
      if (missing.length) {
        const err = new Error("Label, document number and full name are required.");
        err.body = { fields: Object.fromEntries(missing.map((k) => [k, "Required"])) };
        throw err;
      }
      const data = pick(v);
      if (v.ownerId) data.ownerId = v.ownerId;
      if (v.status) data.status = v.status;
      if (entry) await put("/citamate/profiles/" + encodeURIComponent(entry.id), data);
      else await post("/citamate/profiles", data);
      toast(entry ? "Entry saved." : "Entry added.", "ok");
      onDone();
    },
  });
}

/** Appointment statuses (same list as the server). CitaMate offers only the active ones. */
export const ENTRY_STATUSES = [
  { id: "pending", label: "Pending", kind: "info", active: true, hint: "Waiting to start" },
  { id: "in_progress", label: "In progress", kind: "warn", active: true, hint: "Trying to book" },
  { id: "on_hold", label: "On hold", kind: "", active: false, hint: "Paused" },
  { id: "booked", label: "Booked", kind: "ok", active: false, hint: "Appointment confirmed" },
  { id: "done", label: "Done", kind: "ok", active: false, hint: "Attended / finished" },
  { id: "cancelled", label: "Cancelled", kind: "bad", active: false, hint: "Not needed any more" },
];
const statusOf = (id) => ENTRY_STATUSES.find((x) => x.id === id) || ENTRY_STATUSES[0];

export default async function entriesPage() {
  const root = el("div");
  let items = [];
  let counts = null;
  const selected = new Set();
  const search = el("input", { type: "search", placeholder: "Search label, name, document, province…", "aria-label": "Search entries", testid: "entries-search" });
  const statusFilter = el("select", { "aria-label": "Status", testid: "entries-status-filter" },
    el("option", { value: "" }, "All statuses"),
    el("option", { value: "active" }, "Active (shown in CitaMate)"),
    ENTRY_STATUSES.map((x) => el("option", { value: x.id }, x.label)));
  const tiles = el("div", { class: "grid summary-grid", testid: "entries-summary" });
  const listBox = el("div");

  // ---------- status tiles (whole list; click to filter) ----------
  function renderTiles() {
    tiles.textContent = "";
    for (const x of ENTRY_STATUSES) {
      const n = counts ? counts[x.id] || 0 : items.filter((r) => r.status === x.id).length;
      tiles.append(el("button", {
        type: "button",
        class: "card stat stat-btn" + (statusFilter.value === x.id ? " current" : ""),
        testid: "status-tile-" + x.id,
        "aria-pressed": String(statusFilter.value === x.id),
        onclick: () => { statusFilter.value = statusFilter.value === x.id ? "" : x.id; selected.clear(); renderList(); },
      }, el("b", { class: "status-" + x.id }, String(n)), el("span", null, x.label), el("small", null, x.active ? "shown in CitaMate" : x.hint)));
    }
  }

  // ---------- bulk bar ----------
  const bar = el("div", { class: "bulkbar", testid: "entries-bulkbar", hidden: true });
  const barText = el("strong", { testid: "entries-selected" });
  const setStatus = el("select", { "aria-label": "Set status", testid: "bulk-status" },
    el("option", { value: "" }, "Set status…"), ENTRY_STATUSES.map((x) => el("option", { value: x.id }, x.label)));
  async function bulk(action, status) {
    const ids = [...selected];
    if (action === "delete" && !(await confirmDialog(`Delete ${ids.length} entr${ids.length === 1 ? "y" : "ies"}? Their logs are kept.`))) return;
    const r = await post("/citamate/profiles/actions", { ids, action, status });
    toast(action === "delete" ? `Deleted ${r.changed} entries.` : `${r.changed} entr${r.changed === 1 ? "y" : "ies"} set to ${statusOf(status).label}.`, "ok");
    selected.clear();
    await load();
  }
  setStatus.addEventListener("change", async () => {
    const v = setStatus.value;
    setStatus.value = "";
    if (!v) return;
    setStatus.disabled = true;
    try { await bulk("status", v); } catch (e) { toastError(e); } finally { setStatus.disabled = false; }
  });
  bar.append(barText, el("span", { class: "spacer" }), setStatus,
    el("button", { type: "button", class: "btn danger", testid: "bulk-delete", onclick: () => bulk("delete") }, "Delete"),
    el("button", { type: "button", class: "btn link", testid: "bulk-clear", onclick: () => { selected.clear(); renderList(); } }, "Clear"));

  function renderList() {
    renderTiles();
    const term = search.value.trim().toLowerCase();
    const f = statusFilter.value;
    const rows = items.filter((r) =>
      (!f || (f === "active" ? statusOf(r.status).active : r.status === f)) &&
      (!term || [r.label, r.fullName, r.docNumber, r.provinceText, r.tramiteText, r.ownerName].some((v) => String(v || "").toLowerCase().includes(term))));
    const head = el("input", { type: "checkbox", "aria-label": "Select all shown", testid: "entries-select-all" });
    head.checked = rows.length > 0 && rows.every((r) => selected.has(r.id));
    head.indeterminate = !head.checked && rows.some((r) => selected.has(r.id));
    head.addEventListener("change", () => { rows.forEach((r) => (head.checked ? selected.add(r.id) : selected.delete(r.id))); renderList(); });
    const cols = [
      {
        label: head,
        class: "pick",
        render: (r) => {
          const cb = el("input", { type: "checkbox", "aria-label": "Select " + r.label, testid: "row-select" });
          cb.checked = selected.has(r.id);
          cb.addEventListener("change", () => { cb.checked ? selected.add(r.id) : selected.delete(r.id); syncBar(); head.checked = rows.every((x) => selected.has(x.id)); head.indeterminate = !head.checked && rows.some((x) => selected.has(x.id)); });
          return cb;
        },
      },
      {
        label: "Status",
        class: "nowrap",
        render: (r) => {
          const st = statusOf(r.status);
          const sel = el("select", { class: "status-select status-" + st.id, "aria-label": "Status of " + r.label, testid: "row-status", title: st.active ? "Shown in CitaMate" : "Hidden from CitaMate" },
            ENTRY_STATUSES.map((x) => el("option", { value: x.id, selected: x.id === st.id }, x.label)));
          sel.addEventListener("change", async () => {
            sel.disabled = true;
            try {
              await post("/citamate/profiles/actions", { ids: [r.id], action: "status", status: sel.value });
              toast(`${r.label}: ${statusOf(sel.value).label}.`, "ok");
              await load();
            } catch (e) { toastError(e); sel.disabled = false; sel.value = st.id; }
          });
          return el("div", null, sel, r.statusAt ? el("div", { class: "hint" }, ago(r.statusAt)) : null);
        },
      },
      {
        label: "Label",
        render: (r) => el("div", null, el("strong", null, r.label),
          r.officeOpen ? el("div", { class: "office-open", testid: "entry-office-open", title: "Seen open: " + r.officeOpen.offices.join(", ") },
            "🟢 Office open · since " + new Date(r.officeOpen.since).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })) : null),
      },
      { label: "Document", render: (r) => `${r.docType || ""} ${r.docNumber || ""}`.trim() },
      { label: "Name", render: (r) => r.fullName },
      { label: "Province", render: (r) => r.provinceText },
      { label: "Trámite", render: (r) => r.tramiteText, class: "wrap" },
    ];
    if (showOwner()) cols.push({ label: "Owner", render: ownerCell });
    cols.push({ label: "Updated", render: (r) => fmtTime(r.updatedAt) });
    cols.push({
      label: "",
      class: "actions",
      render: (r) =>
        el(
          "span",
          null,
          el("button", { type: "button", class: "btn small", testid: "row-edit", onclick: () => openEditor(r, load) }, "Edit"),
          el("button", {
            type: "button",
            class: "btn small danger",
            testid: "row-delete",
            onclick: async () => {
              if (!(await confirmDialog(`Delete the entry "${r.label}"?`))) return;
              try {
                await del("/citamate/profiles/" + encodeURIComponent(r.id));
                toast("Entry deleted.", "ok");
                load();
              } catch (e) { toastError(e); }
            },
          }, "Delete"),
        ),
    });
    listBox.textContent = "";
    listBox.append(
      table(cols, rows, { testid: "entries-table", empty: items.length ? "No entry matches the search or status." : "No entries yet. Add one or import a JSON file." }),
      el("p", { class: "hint list-foot" }, `${rows.length} of ${items.length} entries · CitaMate shows Pending and In progress entries only.`),
    );
    syncBar();
  }
  function syncBar() {
    bar.hidden = selected.size === 0;
    barText.textContent = `${selected.size} selected`;
  }

  async function load() {
    try {
      const r = await get("/citamate/profiles" + qs({ owner: ownerParam() }));
      items = r.items || [];
      counts = r.counts || null;
    } catch (e) {
      items = [];
      counts = null;
      toastError(e);
    }
    const ids = new Set(items.map((r) => r.id));
    for (const id of [...selected]) if (!ids.has(id)) selected.delete(id);
    renderList();
  }

  async function importFile() {
    const file = await pickFile("application/json,.json");
    if (!file) return;
    let list;
    try {
      const parsed = JSON.parse(await file.text());
      list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.items) ? parsed.items : Array.isArray(parsed.entries) ? parsed.entries : null;
      if (!list) throw new Error("The file has no list of entries.");
    } catch (e) {
      toast("Can't read that file: " + e.message, "error");
      return;
    }
    if (!list.length) return toast("The file is empty.", "error");
    if (list.length > 1000) return toast("At most 1000 entries per import.", "error");
    try {
      const r = await post("/citamate/profiles/bulk", { items: list.map(pick), ...(isAdmin() ? { ownerId: defaultOwnerId() } : {}) });
      toast(`Imported ${(r.items || []).length} entries.`, "ok");
      load();
    } catch (e) { toastError(e); }
  }

  search.addEventListener("input", renderList);
  statusFilter.addEventListener("change", () => { selected.clear(); renderList(); });
  root.append(
    pageHead(
      "CitaMate entries",
      ownerSelect(() => { selected.clear(); load(); }, { created: true }),
      el("button", { type: "button", class: "btn", testid: "entries-import", onclick: importFile }, "Import JSON"),
      el("button", { type: "button", class: "btn", testid: "entries-export", onclick: () => downloadJson("citamate-entries.json", items.map((r) => ({ ...pick(r), id: r.id }))) }, "Export"),
      el("button", { type: "button", class: "btn primary", testid: "entry-add", onclick: () => openEditor(null, load) }, "Add entry"),
    ),
    tiles,
    el("div", { class: "toolbar" }, search, statusFilter),
    bar,
    listBox,
  );
  await load();
  return root;
}
