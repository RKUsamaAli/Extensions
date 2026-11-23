// Entry normalisation shared by the entries page (and the migration). Same rules the server
// applies, so the user sees the final value before saving.
// Classic script in the page (globalThis.CM_ENTRY) and CommonJS in Node tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.CM_ENTRY = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const TEXT_FIELDS = ["label", "docType", "docNumber", "fullName", "birthYear", "phone", "email", "notes"];
  // Select fields store both the option value and its visible text.
  const SELECT_FIELDS = ["nationality", "province", "tramite", "office"];
  const ALL_FIELDS = TEXT_FIELDS.concat(SELECT_FIELDS, SELECT_FIELDS.map((f) => f + "Text"));
  const MAX_LEN = 500;

  /**
   * @param {object} raw     form values / imported / old local entry
   * @param {Array<{value,text}>} paises  catalog countries (maps old free-text nationality)
   * @returns entry fields only (no id, no owner fields)
   */
  function clean(raw, paises) {
    const e = {};
    TEXT_FIELDS.concat(SELECT_FIELDS).forEach((f) => {
      e[f] = String((raw && raw[f]) || "").trim().slice(0, MAX_LEN);
      if (SELECT_FIELDS.includes(f)) e[f + "Text"] = String((raw && raw[f + "Text"]) || "").trim().slice(0, MAX_LEN);
    });
    e.docType = ["NIE", "DNI", "PASAPORTE"].includes(e.docType.toUpperCase()) ? e.docType.toUpperCase() : "NIE";
    e.docNumber = e.docNumber.toUpperCase().replace(/\s+/g, "");
    e.fullName = e.fullName.toUpperCase();
    e.birthYear = e.birthYear.replace(/\D/g, "").slice(0, 4);
    // Older entries saved nationality as free text: map it to the catalog value.
    if (e.nationality && !e.nationalityText) {
      const hit = (paises || []).find((p) => p.value === e.nationality || String(p.text).toUpperCase() === e.nationality.toUpperCase());
      if (hit) {
        e.nationality = hit.value;
        e.nationalityText = hit.text;
      } else {
        e.nationalityText = e.nationality;
      }
    }
    return e;
  }

  /** What the server requires; returns a list of missing field labels. */
  function missing(e) {
    const out = [];
    if (!e.label) out.push("Label");
    if (!e.docNumber) out.push("Document number");
    if (!e.fullName) out.push("Full name");
    return out;
  }

  /** Only the fields the API accepts (drops id, ownerId, createdAt…). */
  const body = (e) => Object.fromEntries(ALL_FIELDS.map((f) => [f, e[f] == null ? "" : String(e[f])]));

  return { clean, missing, body, TEXT_FIELDS, SELECT_FIELDS, ALL_FIELDS };
});
