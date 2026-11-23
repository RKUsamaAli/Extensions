// Admin: CitaMate catalog + per-extension site config (JSON editors).
import { get, put } from "../api.js";
import { el, toast, toastError, fmtTime, downloadJson, pickFile } from "../ui.js";
import { EXTS, pageHead } from "../state.js";

function jsonEditor({ title, hint, load, save, testid, validate }) {
  const area = el("textarea", { class: "code", spellcheck: "false", "aria-label": title, testid: testid + "-json" });
  const meta = el("p", { class: "hint", testid: testid + "-meta" });
  const status = el("div", { class: "hint", role: "status" });
  const parse = () => {
    try {
      const v = JSON.parse(area.value);
      const problem = validate ? validate(v) : null;
      status.textContent = problem || "Valid JSON.";
      status.className = problem ? "field-error" : "hint";
      return problem ? null : v;
    } catch (e) {
      status.textContent = "Invalid JSON: " + e.message;
      status.className = "field-error";
      return null;
    }
  };
  area.addEventListener("input", () => parse());
  const card = el(
    "div",
    { class: "card", testid },
    el("h2", null, title),
    hint ? el("p", { class: "hint" }, hint) : null,
    meta,
    area,
    status,
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
          if (v !== null) area.value = JSON.stringify(v, null, 2);
        },
      }, "Format"),
      el("button", {
        type: "button",
        class: "btn",
        onclick: async () => {
          const f = await pickFile("application/json,.json");
          if (f) { area.value = await f.text(); parse(); }
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
      parse();
    } catch (e) {
      meta.textContent = e.message;
    }
  }
  return { card, refill };
}

export default async function configPage() {
  const catalog = jsonEditor({
    title: "CitaMate catalog",
    testid: "catalog",
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
