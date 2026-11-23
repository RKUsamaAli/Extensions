// One-time upload of the data older CitaMate versions kept in chrome.storage.local
// (keys "entries", "logs", "officeSightings") to the server.
// Classic script (importScripts in the service worker → globalThis.CM_MIGRATE) and CommonJS in tests.
(function (root, factory) {
  const api = factory(typeof require === "function" && typeof module === "object" ? require("./entry.js") : root.CM_ENTRY);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.CM_MIGRATE = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (CM_ENTRY) {
  "use strict";
  const KEYS = ["entries", "logs", "officeSightings"];
  const list = (v) => (Array.isArray(v) ? v : []);

  /** Counts of what is waiting to be uploaded. null = nothing to do. */
  function pending(local) {
    const c = { entries: list(local.entries).length, logs: list(local.logs).length, sightings: list(local.officeSightings).length };
    return c.entries || c.logs || c.sightings ? c : null;
  }

  /** Old entries → { oldIds: [...], items: [api bodies] } in the same order (the bulk API answers in order). */
  function planEntries(entries, paises) {
    const oldIds = [];
    const items = [];
    list(entries).forEach((raw) => {
      const e = CM_ENTRY.clean(raw, paises);
      if (CM_ENTRY.missing(e).length) return; // the server would reject it
      oldIds.push(raw && raw.id ? String(raw.id) : "");
      items.push(CM_ENTRY.body(e));
    });
    return { oldIds, items };
  }

  /** Map old entry id → new server id, from the plan and the bulk reply. */
  function idMap(oldIds, created) {
    const map = {};
    oldIds.forEach((old, i) => {
      if (old && created[i] && created[i].id) map[old] = created[i].id;
    });
    return map;
  }

  let seq = 0;
  const newId = (t) => "m" + Number(t || Date.now()).toString(36) + "-" + (seq++).toString(36) + Math.random().toString(36).slice(2, 6);

  /**
   * Points logs / sightings at the new entry ids. Records that only have a label (very old
   * versions) are matched by label through `labels` (label → new id). Unknown ids are dropped
   * to "" so reports fall back to the label. Every record gets an id (the API de-duplicates by it).
   */
  function remap(records, map, labels) {
    return list(records).map((r) => {
      const out = { ...r };
      if (out.entryId) out.entryId = map[out.entryId] || "";
      if (!out.entryId && out.entry && labels && labels[out.entry]) out.entryId = labels[out.entry];
      if (!out.id) out.id = newId(out.t);
      if (!out.t) out.t = Date.now();
      return out;
    });
  }

  function chunks(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  return { KEYS, pending, planEntries, idMap, remap, chunks };
});
