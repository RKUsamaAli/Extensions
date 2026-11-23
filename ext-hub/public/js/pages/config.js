// Admin: CitaMate catalog + per-extension site config (JSON editors).
import { get, put } from "../api.js";
import { el, toast, toastError, fmtTime, downloadJson, pickFile } from "../ui.js";
import { jsonTree, jsonTable, jsonError } from "../jsonview.js";
import { EXTS, pageHead } from "../state.js";

const VIEWS = [
  ["tree", "Tree"],
  ["table", "Table"],
  ["edit", "Edit JSON"],
];
const savedView = (id) => { try { return localStorage.getItem("eh.view." + id) || "tree"; } catch (_) { return "tree"; } };
const saveView = (id, v) => { try { localStorage.setItem("eh.view." + id, v); } catch (_) { /* private mode */ } };

/**
 * Card with three views of one JSON document: a collapsible tree, data tables and the
 * raw editor. Tree and Table always show what is in the editor (unsaved edits too).
 * view: { labelFor, titles, groups } passed to the viewers.
 */
function jsonEditor({ title, hint, load, save, testid, validate, view = {} }) {
  const area = el("textarea", { class: "code", spellcheck: "false", "aria-label": title, testid: testid + "-json" });
  const meta = el("p", { class: "hint", testid: testid + "-meta" });
  const status = el("div", { class: "hint", role: "status", testid: testid + "-status" });
  const goto = el("button", { type: "button", class: "btn small", hidden: true, testid: testid + "-goto" }, "Show error");
  let errorAt = -1;
  let dirty = false;
  const parse = () => {
    errorAt = -1;
    goto.hidden = true;
    try {
      const v = JSON.parse(area.value);
      const problem = validate ? validate(v) : null;
      status.textContent = problem || (dirty ? "Valid JSON · not saved yet." : "Valid JSON.");
      status.className = problem ? "field-error" : "hint";
      return problem ? null : v;
    } catch (e) {
      const info = jsonError(area.value, e);
      errorAt = info.offset;
      goto.hidden = errorAt < 0;
      status.textContent = "Invalid JSON at " + info.message;
      status.className = "field-error";
      return null;
    }
  };
  goto.addEventListener("click", () => {
    showView("edit");
    area.focus();
    area.setSelectionRange(errorAt, Math.min(area.value.length, errorAt + 1));
    const line = area.value.slice(0, errorAt).split("\n").length;
    area.scrollTop = Math.max(0, (line - 5) * parseFloat(getComputedStyle(area).lineHeight || "18"));
  });
  area.addEventListener("input", () => { dirty = true; parse(); });
  area.addEventListener("keydown", (e) => {
    // Tab indents instead of leaving the editor.
    if (e.key !== "Tab" || e.shiftKey) return;
    e.preventDefault();
    area.setRangeText("  ", area.selectionStart, area.selectionEnd, "end");
    dirty = true;
    parse();
  });

  const viewBox = el("div", { class: "jv-view", testid: testid + "-view" });
  const editBox = el("div", { testid: testid + "-edit" }, area);
  const tabs = el("div", { class: "tabs", role: "tablist", "aria-label": title + " view" });
  let current = savedView(testid);
  function showView(v) {
    current = v;
    saveView(testid, v);
    for (const b of tabs.children) b.setAttribute("aria-selected", String(b.dataset.view === v));
    editBox.hidden = v !== "edit";
    viewBox.hidden = v === "edit";
    if (v === "edit") return;
    viewBox.textContent = "";
    let value;
    try {
      value = JSON.parse(area.value);
    } catch (e) {
      viewBox.append(el("div", { class: "notice" }, "The JSON has an error, so it can't be shown as a " + (v === "tree" ? "tree" : "table") + ". ",
        el("button", { type: "button", class: "btn small", onclick: () => goto.click() }, "Fix it in the editor")));
      return;
    }
    viewBox.append(v === "tree"
      ? jsonTree(value, { openDepth: 1, labelFor: view.labelFor && ((k, path) => view.labelFor(k, path, value)), testid: testid + "-tree" })
      : jsonTable(value, { titles: view.titles, groups: view.groups, labelFor: view.labelFor && ((k, path) => view.labelFor(k, path, value)), fileName: testid, testid: testid + "-table" }));
  }
  for (const [v, label] of VIEWS) {
    tabs.append(el("button", { type: "button", role: "tab", dataset: { view: v }, testid: `${testid}-tab-${v}`, onclick: () => showView(v) }, label));
  }

  const card = el(
    "div",
    { class: "card", testid },
    el("h2", null, title),
    hint ? el("p", { class: "hint" }, hint) : null,
    meta,
    tabs,
    viewBox,
    editBox,
    el("div", { class: "row status-row" }, status, goto),
    el(
      "div",
      { class: "toolbar" },
      el("button", {
        type: "button",
        class: "btn primary",
        testid: testid + "-save",
        onclick: async () => {
          const v = parse();
          if (v === null) return toast("Fix the JSON first.", "error");
          try {
            await save(v);
            await refill();
          } catch (e) { toastError(e); }
        },
      }, "Save"),
      el("button", {
        type: "button",
        class: "btn",
        onclick: () => {
          const v = parse();
          if (v !== null) { area.value = JSON.stringify(v, null, 2); showView(current); }
        },
      }, "Format"),
      el("button", {
        type: "button",
        class: "btn",
        onclick: async () => {
          const f = await pickFile("application/json,.json");
          if (f) { area.value = await f.text(); dirty = true; parse(); showView(current); }
        },
      }, "Load file"),
      el("button", {
        type: "button",
        class: "btn",
        onclick: () => { const v = parse(); if (v !== null) downloadJson(testid + ".json", v); },
      }, "Download"),
      el("button", { type: "button", class: "btn", onclick: () => refill() }, "Discard changes"),
    ),
  );
  async function refill() {
    try {
      const r = await load();
      area.value = JSON.stringify(r.value ?? {}, null, 2);
      meta.textContent = r.meta;
      dirty = false;
      parse();
    } catch (e) {
      meta.textContent = e.message;
    }
    showView(current);
  }
  return { card, refill };
}

/** Catalog: show province names instead of the province URLs used as keys. */
function provinceName(key, path, value) {
  if (path !== "tramites" && path !== "offices" && !/^(tramites|offices)\[/.test(path)) return null;
  const p = value && Array.isArray(value.provinces) ? value.provinces.find((x) => x && x.value === key) : null;
  return p ? p.text : null;
}

export default async function configPage() {
  const catalog = jsonEditor({
    title: "CitaMate catalog",
    testid: "catalog",
    view: {
      labelFor: provinceName,
      titles: { provinces: "Provinces", paises: "Countries", tramites: "Trámites by province", offices: "Offices by province" },
      groups: { tramites: "Province", offices: "Province" },
    },
    hint: "Provinces, countries, trámites and offices the extension shows. Saving publishes a new version; every install downloads it on next start.",
    validate: (v) => {
      if (!v || typeof v !== "object" || Array.isArray(v)) return "The catalog must be an object.";
      if (!Array.isArray(v.provinces) || !Array.isArray(v.paises)) return "provinces and paises must be lists.";
      if (typeof v.tramites !== "object" || typeof v.offices !== "object") return "tramites and offices must be objects keyed by province value.";
      return null;
    },
    load: async () => {
      const r = await get("/admin/catalog/citamate");
      return { value: r.data, meta: `Version ${r.version ?? "—"} · updated ${fmtTime(r.updatedAt)}` };
    },
    save: async (data) => {
      const r = await put("/admin/catalog/citamate", { data });
      toast(`Catalog saved as version ${r.version}.`, "ok");
    },
  });
  const editors = [catalog].concat(
    EXTS.map((x) =>
      jsonEditor({
        title: `${x.name} site config`,
        testid: "site-config-" + x.id,
        view: { titles: { "": "Settings", selectors: "Page selectors", patterns: "Text patterns", urlPages: "Pages by URL", knownMessages: "Known messages", stepButtons: "Step buttons" }, groups: { selectors: "Selector", patterns: "Pattern", stepButtons: "Page" } },
        hint: "Page selectors and settings sent to the extension at start. A wrong value can stop the extension from filling pages – keep a copy before editing.",
        validate: (v) => (v && typeof v === "object" && !Array.isArray(v) ? null : "The config must be an object."),
        load: async () => {
          const r = await get("/admin/site-config/" + x.id);
          return { value: r.config, meta: `Updated ${fmtTime(r.updatedAt)}` };
        },
        save: async (config) => {
          await put("/admin/site-config/" + x.id, { config });
          toast(`${x.name} site config saved.`, "ok");
        },
      }),
    ),
  );
  await Promise.all(editors.map((e) => e.refill()));
  return el("div", null, pageHead("Catalog & config"), editors.map((e) => e.card));
}
