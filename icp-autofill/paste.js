// Parse a colon-separated line into a CitaMate entry (like RelaySwitch's host:port:user:pass).
// Values can be in any order; each part is recognised by its shape or matched against the catalog:
//   NIE:X1234567L:JHON DOE:1990:ALBANIA:Barcelona:4067:600123456:jhon@mail.com
// Recognised: document type (NIE/DNI/Pasaporte), NIE/DNI/passport number, birth year, phone,
// email, nationality, province, trámite (code or name), office (code or part of its name).
// The first part that matches nothing is the full name; a second one becomes the label.
(() => {
  "use strict";
  const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim();

  const DOC_TYPES = { NIE: "NIE", "N.I.E.": "NIE", "N.I.E": "NIE", DNI: "DNI", PASAPORTE: "PASAPORTE", PASSPORT: "PASAPORTE", PAS: "PASAPORTE", PASS: "PASAPORTE" };
  const NIE_RE = /^[XYZ]-?\d{7}-?[A-Z]$/;
  const DNI_RE = /^\d{8}-?[A-Z]$/;
  const PASSPORT_RE = /^(?=.*\d)[A-Z0-9]{6,12}$/;
  const YEAR_RE = /^(19|20)\d{2}$/;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function phoneOf(raw) {
    const t = String(raw).trim();
    if (!/^\+?[\d\s().-]+$/.test(t)) return "";
    const digits = t.replace(/\D/g, "");
    if (digits.length < 9 || digits.length > 13) return "";
    return (t.startsWith("+") ? "+" : "") + digits;
  }

  function catalog() {
    return {
      provinces: window.ICP_PROVINCES || [],
      paises: window.ICP_PAISES || [],
      tramites: window.ICP_TRAMITES || {},
      offices: window.ICP_OFFICES || {},
    };
  }

  // Exact (accent-insensitive) match first, then "starts with", then "contains" for longer tokens.
  function findIn(list, token, { byValue = true, minContains = 4 } = {}) {
    const t = norm(token);
    if (!t) return null;
    if (byValue) {
      const v = list.find((o) => String(o.value) === String(token).trim());
      if (v) return v;
    }
    return (
      list.find((o) => norm(o.text) === t) ||
      list.find((o) => norm(o.text).startsWith(t + " ") || norm(o.text).startsWith(t + ",")) ||
      (t.length >= minContains ? list.find((o) => norm(o.text).includes(t)) : null) ||
      null
    );
  }

  const realOffices = (list) => (list || []).filter((o) => String(o.value) !== "99");

  /** Returns { entry, filled: [field names], unknown: [tokens], warnings: [text] } */
  function parseLine(line) {
    const C = catalog();
    const tokens = String(line || "").split(":").map((s) => s.trim()).filter(Boolean);
    const e = {};
    const filled = [];
    const unknown = [];
    const warnings = [];
    const set = (field, value, label) => {
      e[field] = value;
      filled.push(label || field);
    };
    const later = []; // tokens that may be a trámite / office / name, resolved once the province is known

    for (const raw of tokens) {
      const t = norm(raw);
      const compact = t.replace(/[\s-]/g, "");
      if (DOC_TYPES[t] && !e.docType) set("docType", DOC_TYPES[t], "Doc type");
      else if (EMAIL_RE.test(raw) && !e.email) set("email", raw.trim(), "Email");
      else if (NIE_RE.test(compact) && !e.docNumber) {
        set("docNumber", compact.replace(/-/g, ""), "Document");
        if (!e.docType) e.docType = "NIE";
      } else if (DNI_RE.test(compact) && !e.docNumber) {
        set("docNumber", compact.replace(/-/g, ""), "Document");
        if (!e.docType) e.docType = "DNI";
      } else if (YEAR_RE.test(t) && !e.birthYear) set("birthYear", t, "Birth year");
      else if (phoneOf(raw) && !e.phone && !/^\d{4}$/.test(t)) set("phone", phoneOf(raw), "Phone");
      else {
        const prov = !e.province && findIn(C.provinces, raw, { byValue: false, minContains: 99 });
        const pais = !e.nationality && findIn(C.paises, raw, { minContains: 99 });
        if (prov) {
          e.province = prov.value;
          e.provinceText = prov.text;
          filled.push("Province");
        } else if (pais) {
          e.nationality = pais.value;
          e.nationalityText = pais.text;
          filled.push("Nationality");
        } else later.push(raw);
      }
    }

    // Trámite / office need the province's lists. Without a province, search every province.
    const provKeys = e.province ? [e.province] : Object.keys(C.tramites);
    const rest = [];
    for (const raw of later) {
      let done = false;
      if (!e.tramite) {
        for (const k of provKeys) {
          const hit = findIn(C.tramites[k] || [], raw, { minContains: 5 });
          if (hit) {
            e.tramite = hit.value;
            e.tramiteText = hit.text;
            filled.push("Trámite");
            done = true;
            break;
          }
        }
      }
      if (!done && !e.office && e.province) {
        const hit = findIn(realOffices(C.offices[e.province]), raw, { minContains: 4 });
        if (hit) {
          e.office = hit.value;
          e.officeText = hit.text;
          filled.push("Office");
          done = true;
        }
      }
      if (!done) rest.push(raw);
    }

    // Leftovers: a passport number, then the name, then the label.
    for (const raw of rest) {
      const compact = norm(raw).replace(/[\s-]/g, "");
      if (!e.docNumber && PASSPORT_RE.test(compact) && /\d/.test(compact)) {
        set("docNumber", compact, "Document");
        if (!e.docType) e.docType = "PASAPORTE";
      } else if (!e.fullName && /[A-Za-zÀ-ÿ]/.test(raw)) set("fullName", norm(raw), "Name");
      else if (!e.label) set("label", raw.trim(), "Label");
      else unknown.push(raw);
    }

    // A trámite given before its province was known: re-check it belongs to that province.
    if (e.tramite && e.province && !(C.tramites[e.province] || []).some((t) => t.value === e.tramite)) {
      const again = (C.tramites[e.province] || []).find((t) => norm(t.text) === norm(e.tramiteText));
      if (again) e.tramite = again.value;
      else warnings.push("Trámite isn't offered in " + e.provinceText);
    }
    if (e.tramite && !e.province) warnings.push("Add the province so CitaMate can select the trámite");
    if (!e.docNumber) warnings.push("No document number found");
    if (!e.fullName) warnings.push("No name found");
    if (e.docType && e.docNumber) {
      if (e.docType === "NIE" && !NIE_RE.test(e.docNumber)) warnings.push("Document doesn't look like an NIE (X/Y/Z + 7 digits + letter)");
      if (e.docType === "DNI" && !DNI_RE.test(e.docNumber)) warnings.push("Document doesn't look like a DNI (8 digits + letter)");
    }
    if (!e.label && e.fullName) {
      const tr = (e.tramiteText || "").replace(/^POLIC[IÍ]A\s*-\s*/i, "").split(/[(,]/)[0].trim();
      e.label = [e.fullName.split(" ")[0], tr || e.provinceText].filter(Boolean).join(" – ");
    }
    if (!e.docType) e.docType = "NIE";
    return { entry: e, filled, unknown, warnings };
  }

  /** One entry per line. Blank lines and lines starting with # are skipped. */
  function parseBulk(text, existingDocs) {
    const seen = new Set((existingDocs || []).map((d) => norm(d)));
    const out = { rows: [], duplicates: 0 };
    String(text || "")
      .split(/\r?\n/)
      .forEach((rawLine, i) => {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) return;
        const r = parseLine(line);
        const doc = norm(r.entry.docNumber);
        if (doc && seen.has(doc)) {
          out.duplicates++;
          return;
        }
        if (doc) seen.add(doc);
        out.rows.push({ line: i + 1, text: line, ...r, ok: !!(r.entry.docNumber && r.entry.fullName) });
      });
    return out;
  }

  window.CM_PASTE = { parseLine, parseBulk };
})();
