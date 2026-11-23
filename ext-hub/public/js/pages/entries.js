// CitaMate entries (profiles).
import { get, post, put, del, qs } from "../api.js";
import { el, table, drawer, confirmDialog, toast, toastError, field, input, select, formValues, fmtTime, downloadJson, pickFile } from "../ui.js";
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
      if (entry) await put("/citamate/profiles/" + encodeURIComponent(entry.id), data);
      else await post("/citamate/profiles", data);
      toast(entry ? "Entry saved." : "Entry added.", "ok");
      onDone();
    },
  });
}

export default async function entriesPage() {
  const root = el("div");
  let items = [];
  const search = el("input", { type: "search", placeholder: "Search label, name, document, province…", "aria-label": "Search entries", testid: "entries-search" });
  const listBox = el("div");

  function renderList() {
    const term = search.value.trim().toLowerCase();
    const rows = items.filter(
      (r) => !term || [r.label, r.fullName, r.docNumber, r.provinceText, r.tramiteText, r.ownerName].some((v) => String(v || "").toLowerCase().includes(term)),
    );
    const cols = [
      { label: "Label", render: (r) => el("strong", null, r.label) },
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
      table(cols, rows, { testid: "entries-table", empty: items.length ? "No entry matches the search." : "No entries yet. Add one or import a JSON file." }),
      el("p", { class: "hint" }, `${rows.length} of ${items.length} entries`),
    );
  }

  async function load() {
    try {
      items = (await get("/citamate/profiles" + qs({ owner: ownerParam() }))).items || [];
    } catch (e) {
      items = [];
      toastError(e);
    }
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
  root.append(
    pageHead(
      "CitaMate entries",
      ownerSelect(load, { created: true }),
      el("button", { type: "button", class: "btn", testid: "entries-import", onclick: importFile }, "Import JSON"),
      el("button", { type: "button", class: "btn", testid: "entries-export", onclick: () => downloadJson("citamate-entries.json", items.map((r) => ({ ...pick(r), id: r.id }))) }, "Export"),
      el("button", { type: "button", class: "btn primary", testid: "entry-add", onclick: () => openEditor(null, load) }, "Add entry"),
    ),
    el("div", { class: "toolbar" }, search),
    listBox,
  );
  await load();
  return root;
}
