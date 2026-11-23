// JSON viewers: collapsible tree, data tables and a compact inline view.
// Built with textContent only (no innerHTML) and classes only (strict CSP).
import { el } from "./ui.js";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isContainer = (v) => v !== null && typeof v === "object";
const isScalar = (v) => !isContainer(v);
const fold = (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const clip = (s, n = 80) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function pathOf(parent, key, inArray) {
  if (inArray) return `${parent}[${key}]`;
  return /^[A-Za-z_$][\w$]*$/.test(key) ? (parent ? `${parent}.${key}` : key) : `${parent}[${JSON.stringify(key)}]`;
}

/** Text with every match of q wrapped in <mark>. */
function highlight(text, q) {
  text = String(text);
  if (!q) return text;
  const hay = fold(text);
  const out = [];
  let i = 0;
  for (let at = hay.indexOf(q); at !== -1; at = hay.indexOf(q, i)) {
    if (at > i) out.push(text.slice(i, at));
    out.push(el("mark", null, text.slice(at, at + q.length)));
    i = at + q.length;
  }
  if (i < text.length) out.push(text.slice(i));
  return out;
}

function scalarNode(v, q) {
  if (v === null) return el("span", { class: "jv-null" }, "null");
  if (typeof v === "string") return el("span", { class: "jv-s" }, "“", highlight(v, q), "”");
  if (typeof v === "number") return el("span", { class: "jv-n" }, highlight(String(v), q));
  if (typeof v === "boolean") return el("span", { class: "jv-b" }, String(v));
  return el("span", null, String(v));
}

function sizeLabel(v) {
  if (Array.isArray(v)) return `${v.length} item${v.length === 1 ? "" : "s"}`;
  const n = Object.keys(v).length;
  return `${n} field${n === 1 ? "" : "s"}`;
}

const NAME_KEYS = ["text", "name", "label", "title", "username", "description"];
/** "usernameTemplate" -> "Username template", "text" -> "Text" (keys stay as they are elsewhere). */
const humanize = (k) => { const t = String(k).replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase(); return t.charAt(0).toUpperCase() + t.slice(1); };

/** One-line summary shown next to a closed node. */
function preview(v, labelOf) {
  if (Array.isArray(v)) {
    const parts = v.slice(0, 3).map((x) => (isScalar(x) ? String(x) : isObj(x) && "text" in x ? String(x.text) : isObj(x) ? Object.keys(x).join(", ") : "[…]"));
    return clip(parts.join(" · ") + (v.length > 3 ? " …" : ""));
  }
  // Objects: lead with a name-like field, then the other simple values ("A Coruña · value: /icp…").
  const entries = Object.entries(v);
  const lead = entries.find(([k, x]) => NAME_KEYS.includes(k) && isScalar(x) && x !== null && x !== "");
  const simple = entries.filter(([k, x]) => isScalar(x) && (!lead || k !== lead[0]));
  if (lead || simple.length === entries.length) {
    const parts = (lead ? [String(lead[1])] : []).concat(simple.slice(0, lead ? 2 : 3).map(([k, x]) => `${k}: ${x === null ? "null" : x}`));
    return clip(parts.join(" · "));
  }
  const keys = Object.keys(v).map((k) => (labelOf && labelOf(k)) || k);
  return clip(keys.slice(0, 5).join(", ") + (keys.length > 5 ? ", …" : ""));
}

// --------------------------------------------------------------- tree ----
/** Copy of v keeping only branches whose key or scalar value contains q (undefined = no match). */
function prune(v, q, key) {
  const keyHit = key != null && fold(key).includes(q);
  if (isScalar(v)) return keyHit || fold(v === null ? "null" : v).includes(q) ? v : undefined;
  if (keyHit) return v;
  if (Array.isArray(v)) {
    const out = [];
    const idx = [];
    v.forEach((x, i) => {
      const p = prune(x, q, null);
      if (p !== undefined) { out.push(p); idx.push(i); }
    });
    if (!out.length) return undefined;
    out.__idx = idx; // original positions, so the tree shows real indexes
    return out;
  }
  const out = {};
  let any = false;
  for (const [k, x] of Object.entries(v)) {
    const p = prune(x, q, k);
    if (p !== undefined) { out[k] = p; any = true; }
  }
  return any ? out : undefined;
}

function treeNode(key, v, path, depth, ctx, inArray) {
  const keyEl = key == null ? null : el("span", { class: inArray ? "jv-i" : "jv-k", title: path }, inArray ? key : highlight(key, ctx.q));
  const label = key != null && !inArray && ctx.labelFor ? ctx.labelFor(key, path) : null;
  const labelEl = label ? el("span", { class: "jv-label" }, label) : null;
  if (isScalar(v)) {
    return el("div", { class: "jv-row" }, keyEl, labelEl, keyEl ? el("span", { class: "jv-colon" }, ":") : null, scalarNode(v, ctx.q));
  }
  const node = el("details", { class: "jv-node" });
  const sum = el(
    "summary",
    { class: "jv-row" },
    keyEl,
    labelEl,
    el("span", { class: "jv-size" }, (Array.isArray(v) ? "[ " : "{ ") + sizeLabel(v) + (Array.isArray(v) ? " ]" : " }")),
    el("span", { class: "jv-preview" }, preview(v, ctx.labelFor && !Array.isArray(v) ? (k) => ctx.labelFor(k, pathOf(path, k, false)) : null)),
  );
  node.append(sum);
  let filled = false;
  const fill = () => {
    if (filled) return;
    filled = true;
    const kids = el("div", { class: "jv-kids" });
    if (Array.isArray(v)) {
      v.forEach((x, i) => kids.append(treeNode(String(v.__idx ? v.__idx[i] : i), x, pathOf(path, v.__idx ? v.__idx[i] : i, true), depth + 1, ctx, true)));
    } else {
      for (const [k, x] of Object.entries(v)) kids.append(treeNode(k, x, pathOf(path, k, false), depth + 1, ctx, false));
    }
    node.append(kids);
  };
  if (depth < ctx.openDepth) {
    node.open = true;
    fill();
  }
  node.addEventListener("toggle", () => node.open && fill());
  return node;
}

/**
 * Collapsible JSON tree with search and expand/collapse all.
 * opts: { openDepth = 1, labelFor(key, path) -> string|null, testid }
 */
export function jsonTree(value, { openDepth = 1, labelFor = null, testid = "json-tree", toolbar = true } = {}) {
  const box = el("div", { class: "jv-tree", testid: testid + "-body" });
  const count = el("span", { class: "hint", role: "status" });
  const search = el("input", { type: "search", placeholder: "Search keys and values", "aria-label": "Search keys and values", testid: testid + "-search" });
  const draw = (depth) => {
    const q = fold(search.value.trim());
    box.textContent = "";
    if (!q) {
      count.textContent = "";
      box.append(treeNode(null, value, "", 0, { q: "", openDepth: depth, labelFor }, false));
      return;
    }
    const pruned = prune(value, q, null);
    if (pruned === undefined) {
      count.textContent = "No matches.";
      return;
    }
    box.append(treeNode(null, pruned, "", 0, { q, openDepth: Infinity, labelFor }, false));
    count.textContent = `${box.querySelectorAll("mark").length} match${box.querySelectorAll("mark").length === 1 ? "" : "es"}`;
  };
  let timer = 0;
  search.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => draw(openDepth), 150);
  });
  const wrap = el("div", { class: "jv", testid });
  if (toolbar) {
    wrap.append(
      el(
        "div",
        { class: "toolbar" },
        search,
        el("button", { type: "button", class: "btn small", testid: testid + "-expand", onclick: () => draw(Infinity) }, "Expand all"),
        el("button", { type: "button", class: "btn small", testid: testid + "-collapse", onclick: () => { search.value = ""; draw(1); } }, "Collapse all"),
        count,
      ),
    );
  }
  wrap.append(box);
  draw(openDepth);
  return wrap;
}

// -------------------------------------------------------------- table ----
/**
 * Splits a JSON value into tables a person can read:
 *   array of objects          -> one row per item
 *   array of scalars          -> one "Value" column
 *   object of arrays (groups) -> one table, first column = the group key
 *   object of objects         -> one row per key
 *   scalar fields             -> Field | Value
 * opts.titles   { path: "Friendly title" }
 * opts.groups   { path: "Group column name" }  (default "Key")
 * opts.labelFor(key, path) -> display text for a group / row key
 */
export function tableSections(value, { titles = {}, groups = {}, labelFor = null } = {}) {
  const sections = [];
  const title = (path, fallback) => titles[path] || fallback || path || "Value";
  const keyText = (k, path) => (labelFor && labelFor(k, path)) || k;

  function walk(v, path, name) {
    if (Array.isArray(v)) {
      if (!v.length) return;
      if (v.every(isObj)) sections.push({ path, title: title(path, name), rows: v.map((x) => ({ ...x })) });
      else if (v.every(isScalar)) sections.push({ path, title: title(path, name), rows: v.map((x) => ({ Value: x })) });
      else sections.push({ path, title: title(path, name), rows: v.map((x, i) => ({ "#": i, Value: x })) });
      return;
    }
    if (!isObj(v)) return;
    const entries = Object.entries(v);
    if (entries.length && entries.every(([, x]) => Array.isArray(x) && x.every(isObj))) {
      const g = groups[path] || "Key";
      const rows = [];
      for (const [k, list] of entries) for (const item of list) rows.push({ [g]: keyText(k, path), ...item });
      sections.push({ path, title: title(path, name), rows, group: g });
      return;
    }
    // Object of objects (patterns, stepButtons…): one row per key; deeper values stay inside their cell.
    if (entries.length > 1 && entries.every(([, x]) => isObj(x))) {
      const g = groups[path] || "Key";
      sections.push({ path, title: title(path, name), rows: entries.map(([k, x]) => (isRegex(x) ? { [g]: keyText(k, path), Pattern: x } : { [g]: keyText(k, path), ...x })), group: g });
      return;
    }
    const scalars = entries.filter(([, x]) => !isContainer(x) || (Array.isArray(x) && x.every(isScalar)));
    if (scalars.length) {
      sections.push({ path, title: title(path, path ? name : "Overview"), rows: scalars.map(([k, x]) => ({ Field: k, Value: x })), group: "Field" });
    }
    for (const [k, x] of entries) {
      if (isContainer(x) && !(Array.isArray(x) && x.every(isScalar))) walk(x, pathOf(path, k, false), k);
    }
  }
  walk(value, "", "");
  for (const s of sections) {
    const cols = [];
    for (const r of s.rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
    s.columns = cols;
  }
  return sections;
}

/** { source, flags } as stored for regular expressions in the site config. */
function isRegex(v) {
  return isObj(v) && typeof v.source === "string" && Object.keys(v).every((k) => k === "source" || k === "flags" || k === "note");
}
function regexNode(v) {
  return el("span", { class: "jv-regex", title: v.note || null }, el("span", { class: "mono" }, `/${v.source}/${v.flags || ""}`), v.note ? el("span", { class: "hint" }, " " + v.note) : null);
}

function cellNode(v) {
  if (v === undefined) return el("span", { class: "jv-null" }, "—");
  if (isRegex(v)) return regexNode(v);
  if (isObj(v) && Object.values(v).some(isRegex)) {
    return el("span", { class: "jv-pairs" }, Object.entries(v).map(([k, x]) => el("span", { class: "jv-pair" }, el("span", { class: "jv-k" }, k), ": ",
      isRegex(x) ? regexNode(x) : Array.isArray(x) && x.every(isScalar) ? x.join(", ") : isScalar(x) ? String(x) : jsonInline(x))));
  }
  if (isScalar(v)) return v === null ? el("span", { class: "jv-null" }, "null") : typeof v === "boolean" ? el("span", { class: "jv-b" }, String(v)) : String(v);
  if (Array.isArray(v) && v.every(isScalar)) return el("span", { class: "jv-chips" }, v.map((x) => el("span", { class: "jv-chip" }, String(x))));
  return jsonInline(v);
}

const cellText = (v) => (v === undefined || v === null ? "" : isScalar(v) ? String(v) : JSON.stringify(v));

function toCsv(columns, rows) {
  const esc = (s) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return [columns.map(esc).join(","), ...rows.map((r) => columns.map((c) => esc(cellText(r[c]))).join(","))].join("\r\n");
}

const MAX_ROWS = 300;

/** Data-table view of a JSON value with section picker, search, sorting and CSV export. */
export function jsonTable(value, { testid = "json-table", fileName = "data", ...opts } = {}) {
  const sections = tableSections(value, opts);
  const wrap = el("div", { class: "jv", testid });
  if (!sections.length) {
    wrap.append(el("p", { class: "hint" }, "Nothing to show as a table."));
    return wrap;
  }
  let current = sections[0];
  let sort = { col: null, dir: 1 };
  let showAll = false;
  const picker = el("div", { class: "jv-sections", role: "tablist", "aria-label": "Tables" });
  const search = el("input", { type: "search", placeholder: "Filter rows", "aria-label": "Filter rows", testid: testid + "-search" });
  const count = el("span", { class: "hint", role: "status", testid: testid + "-count" });
  const box = el("div");

  const drawPicker = () => {
    picker.textContent = "";
    for (const s of sections) {
      picker.append(
        el("button", {
          type: "button",
          role: "tab",
          class: "jv-pill",
          "aria-selected": String(s === current),
          testid: testid + "-section",
          onclick: () => { current = s; sort = { col: null, dir: 1 }; showAll = false; search.value = ""; drawPicker(); draw(); },
        }, s.title, el("span", { class: "jv-pill-n" }, String(s.rows.length))),
      );
    }
  };

  const draw = () => {
    const q = fold(search.value.trim());
    let rows = current.rows;
    if (q) rows = rows.filter((r) => current.columns.some((c) => fold(cellText(r[c])).includes(q)));
    if (sort.col) {
      const c = sort.col;
      rows = rows.slice().sort((a, b) => {
        const x = a[c], y = b[c];
        if (typeof x === "number" && typeof y === "number") return (x - y) * sort.dir;
        return cellText(x).localeCompare(cellText(y), undefined, { numeric: true, sensitivity: "base" }) * sort.dir;
      });
    }
    const shown = showAll ? rows : rows.slice(0, MAX_ROWS);
    count.textContent = rows.length === current.rows.length ? `${rows.length} rows` : `${rows.length} of ${current.rows.length} rows`;
    box.textContent = "";
    const head = el(
      "tr",
      null,
      current.columns.map((c) =>
        el("th", { scope: "col", "aria-sort": sort.col === c ? (sort.dir > 0 ? "ascending" : "descending") : null },
          el("button", { type: "button", class: "jv-sort", title: c, onclick: () => { sort = { col: c, dir: sort.col === c ? -sort.dir : 1 }; draw(); } },
            humanize(c), el("span", { class: "jv-sort-mark", "aria-hidden": "true" }, sort.col === c ? (sort.dir > 0 ? " ▲" : " ▼") : "")),
        ),
      ),
    );
    const body = el("tbody", null, shown.map((r) => el("tr", { testid: "row" }, current.columns.map((c) => el("td", { class: c === current.group ? "jv-groupcell" : "wrap" }, cellNode(r[c]))))));
    box.append(el("div", { class: "table-wrap jv-tablewrap" }, el("table", { testid: testid + "-grid" }, el("thead", null, head), body)));
    if (rows.length > shown.length) {
      box.append(el("div", { class: "toolbar" }, el("button", { type: "button", class: "btn small", onclick: () => { showAll = true; draw(); } }, `Show all ${rows.length} rows`)));
    }
  };

  let timer = 0;
  search.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(draw, 150); });
  const csv = el("button", {
    type: "button",
    class: "btn small",
    onclick: () => {
      const blob = new Blob(["﻿" + toCsv(current.columns, current.rows)], { type: "text/csv" });
      const a = el("a", { href: URL.createObjectURL(blob), download: `${fileName}-${fold(current.title).replace(/[^a-z0-9]+/g, "-")}.csv` });
      document.body.append(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
    },
  }, "Download CSV");
  wrap.append(picker, el("div", { class: "toolbar" }, search, csv, count), box);
  drawPicker();
  draw();
  return wrap;
}

// ------------------------------------------------------------- inline ----
/** Compact value for table cells: short objects as "key: value", bigger ones as an expandable tree. */
export function jsonInline(v) {
  if (v === undefined || v === null || v === "") return "—";
  if (typeof v === "string") {
    if (/^[[{]/.test(v.trim())) {
      try { return jsonInline(JSON.parse(v)); } catch (_) { /* plain text */ }
    }
    return v;
  }
  if (isScalar(v)) return String(v);
  const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x]) : Object.entries(v);
  if (!entries.length) return Array.isArray(v) ? "[ ]" : "{ }";
  const simple = entries.length <= 4 && entries.every(([, x]) => isScalar(x) || (Array.isArray(x) && x.length <= 5 && x.every(isScalar)));
  if (simple && !Array.isArray(v)) {
    return el("span", { class: "jv-pairs" }, entries.map(([k, x]) =>
      el("span", { class: "jv-pair" }, el("span", { class: "jv-k" }, k), ": ", Array.isArray(x) ? x.join(", ") : x === null ? "null" : String(x))));
  }
  if (Array.isArray(v) && v.every(isScalar) && v.length <= 8) return el("span", { class: "jv-chips" }, v.map((x) => el("span", { class: "jv-chip" }, String(x))));
  const d = el("details", { class: "jv-inline" }, el("summary", null, el("span", { class: "jv-size" }, sizeLabel(v)), " ", el("span", { class: "jv-preview" }, preview(v))));
  let filled = false;
  d.addEventListener("toggle", () => {
    if (!d.open || filled) return;
    filled = true;
    d.append(jsonTree(v, { openDepth: 2, toolbar: false }));
  });
  return d;
}

/** "Invalid JSON …" message with the line and column of the error, plus its offset (or -1). */
export function jsonError(text, err) {
  const m = /position (\d+)/.exec(err.message);
  if (!m) return { message: err.message, offset: -1 };
  const offset = Number(m[1]);
  const before = text.slice(0, offset).split("\n");
  const line = before.length;
  const col = before[before.length - 1].length + 1;
  const reason = err.message.replace(/\s*in JSON at position \d+.*$/, "").replace(/\s*\(line \d+ column \d+\)$/, "");
  return { message: `line ${line}, column ${col}: ${reason}`, offset };
}
