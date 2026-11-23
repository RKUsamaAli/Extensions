// Activity: CitaMate logs, office sightings, RelaySwitch logs.
import { get, del, qs } from "../api.js";
import { el, table, toast, toastError, confirmDialog, fmtTime, badge, skeletonRows, drawer } from "../ui.js";
import { jsonTree } from "../jsonview.js";
import { ownerParam, ownerSelect, pageHead, showOwner } from "../state.js";

const STATUS = { done: ["Done", "ok"], ok: ["OK", "ok"], fail: ["Failed", "bad"], stuck: ["Stuck", "warn"], wait: ["Waiting", "warn"], info: ["Info", "info"], run: ["Running", "info"] };
const LEVEL = { info: ["Info", "info"], warn: ["Warning", "warn"], error: ["Error", "bad"] };
const pill = (map, k) => (map[k] ? badge(map[k][0], map[k][1]) : badge(k || "—"));

const isError = (r) => r.status === "fail" || r.status === "stuck";

// ---------- page snapshots of failed CitaMate steps ----------
const fieldText = (f) => `${f.type || f.tag}${f.id ? "#" + f.id : ""}${f.name ? "[" + f.name + "]" : ""}${f.label ? " '" + f.label + "'" : ""}${f.visible === false ? " (hidden)" : ""}`;
const buttonText = (b) => `${b.text || "(no text)"}${b.id ? " #" + b.id : ""}${b.name ? " [" + b.name + "]" : ""}${b.visible === false ? " (hidden)" : ""}`;

function openSnapshot(r) {
  const c = r.context || {};
  const kv = (k, v) => (v ? el("div", { class: "snap-kv" }, el("span", { class: "hint" }, k), el("span", null, v)) : null);
  drawer({
    title: `Page details · ${r.page || c.page || "page"}`,
    saveLabel: "Done",
    wide: true,
    testid: "snapshot-drawer",
    onSave: () => {},
    body: el(
      "div",
      { class: "stack wide-stack" },
      el("div", { class: "snap-summary" },
        kv("When", fmtTime(r.t)), kv("Entry", r.entry), kv("Result", r.detail), kv("URL", c.url || r.url), kv("Title", c.title), kv("Heading", c.heading),
        kv("Site message", c.siteMessage), kv("Site alert", c.alert), kv("Filled", (c.filled || []).join(", ")),
        kv("Missing", (c.missing || []).join(", ")), kv("Config / extension", `site config v${c.configVersion ?? "?"} · CitaMate ${c.extensionVersion || "?"}`)),
      (c.tried || []).length
        ? [el("h3", null, "Selectors tried for the missing fields"), table([
            { label: "Field", render: (t) => t.field },
            { label: "Config key", render: (t) => el("span", { class: "mono" }, t.configKey) },
            { label: "Selectors", class: "wrap", render: (t) => el("span", { class: "mono" }, (t.selectors || []).join("  |  ")) },
          ], c.tried, { testid: "snapshot-tried" })]
        : null,
      el("h3", null, `Fields on the page (${(c.fields || []).length})`),
      table([
        { label: "Type", render: (f) => f.type || f.tag },
        { label: "id", render: (f) => el("span", { class: "mono" }, f.id) },
        { label: "name", render: (f) => el("span", { class: "mono" }, f.name) },
        { label: "Label", class: "wrap", render: (f) => f.label },
        { label: "State", class: "wrap", render: (f) => [f.visible === false ? "hidden" : "", f.disabled ? "disabled" : "", f.required ? "required" : "", f.hasValue ? "filled" : "", f.checked ? "checked" : "",
          f.optionCount != null ? `${f.optionCount} options${f.selected ? ", selected: " + f.selected : ""}` : ""].filter(Boolean).join(", ") },
        { label: "Options", class: "wrap", render: (f) => (f.options || []).join("  |  ") },
      ], c.fields || [], { testid: "snapshot-fields", empty: "No fields on this page." }),
      el("h3", null, `Buttons (${(c.buttons || []).length})`),
      table([
        { label: "Text", render: (b) => b.text },
        { label: "id", render: (b) => el("span", { class: "mono" }, b.id) },
        { label: "name / type", render: (b) => [b.name, b.type || b.tag].filter(Boolean).join(" · ") },
        { label: "Visible", render: (b) => (b.visible === false ? "no" : "yes") },
      ], c.buttons || [], { testid: "snapshot-buttons", empty: "No buttons on this page." }),
      el("h3", null, "Raw snapshot"),
      jsonTree(c, { openDepth: 1, testid: "snapshot-json" }),
    ),
  });
}

/** CSV of failed / stuck steps with their page snapshot, to fix the site config. */
function exportErrorsCsv(rows, withOwner) {
  const cols = [
    ["Time", (r) => new Date(r.t).toISOString()],
    ...(withOwner ? [["Owner", (r) => r.ownerName]] : []),
    ["Entry", (r) => r.entry], ["Type", (r) => r.kind || "booking"], ["Page", (r) => r.page], ["Action", (r) => r.action], ["Result", (r) => r.status],
    ["Detail", (r) => r.detail], ["URL", (r) => (r.context && r.context.url) || r.url], ["Title", (r) => r.context && r.context.title],
    ["Heading", (r) => r.context && r.context.heading], ["Site message", (r) => r.context && r.context.siteMessage], ["Site alert", (r) => r.context && r.context.alert],
    ["Filled", (r) => ((r.context && r.context.filled) || []).join(", ")], ["Missing", (r) => ((r.context && r.context.missing) || []).join(", ")],
    ["Config keys tried", (r) => ((r.context && r.context.tried) || []).map((t) => `${t.field}: ${t.configKey}`).join("; ")],
    ["Selectors tried", (r) => ((r.context && r.context.tried) || []).map((t) => `${t.field}: ${(t.selectors || []).join(" | ")}`).join("; ")],
    ["Visible fields", (r) => ((r.context && r.context.fields) || []).filter((f) => f.visible !== false).map(fieldText).join("; ")],
    ["Dropdowns", (r) => ((r.context && r.context.fields) || []).filter((f) => f.options).map((f) => `${f.id || f.name}: ${f.options.join(" | ")}`).join("; ")],
    ["Buttons", (r) => ((r.context && r.context.buttons) || []).filter((b) => b.visible !== false).map(buttonText).join("; ")],
    ["Site config version", (r) => r.context && r.context.configVersion], ["CitaMate version", (r) => r.context && r.context.extensionVersion],
    ["Snapshot JSON", (r) => (r.context ? JSON.stringify(r.context) : "")],
  ];
  const esc = (v) => { const s = v == null ? "" : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csv = [cols.map(([h]) => esc(h)).join(","), ...rows.map((r) => cols.map(([, f]) => esc(f(r))).join(","))].join("\r\n");
  const a = el("a", { href: URL.createObjectURL(new Blob(["\ufeff" + csv], { type: "text/csv" })), download: `citamate-errors-${new Date().toISOString().slice(0, 10)}.csv` });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
}

const TABS = [
  {
    id: "citamate-logs",
    title: "CitaMate log",
    path: "/citamate/logs",
    query: { context: "1" },
    errors: true,
    filters: [
      { key: "status", label: "Result", options: [["errors", "Errors only (failed + stuck)"], ...Object.entries(STATUS).map(([v, [t]]) => [v, t])] },
      { key: "kind", label: "Type", options: [["booking", "Booking"], ["check", "Office check"]] },
    ],
    match: (r, f) => (!f.status || (f.status === "errors" ? isError(r) : r.status === f.status)) && (!f.kind || (r.kind || "booking") === f.kind),
    text: (r) => [r.entry, r.page, r.action, r.detail, r.url],
    columns: () => [
      { label: "Time", render: (r) => fmtTime(r.t) },
      { label: "Result", render: (r) => pill(STATUS, r.status) },
      { label: "Entry", render: (r) => r.entry },
      { label: "Page", render: (r) => r.page },
      { label: "Action", render: (r) => r.action },
      { label: "Detail", render: (r) => r.detail, class: "wrap" },
      { label: "", class: "actions", render: (r) => (r.context ? el("button", { type: "button", class: "btn small", testid: "row-snapshot", onclick: () => openSnapshot(r) }, "Page details") : "") },
    ],
  },
  {
    id: "offices",
    title: "Office sightings",
    path: "/citamate/office-sightings",
    filters: [{ key: "kind", label: "Type", options: [["booking", "Booking"], ["check", "Office check"]] }],
    match: (r, f) => !f.kind || (r.kind || "booking") === f.kind,
    text: (r) => [r.entry, r.province, r.tramite].concat((r.offices || []).map((o) => o.text)),
    columns: () => [
      { label: "Time", render: (r) => fmtTime(r.t) },
      { label: "Entry", render: (r) => r.entry },
      { label: "Province", render: (r) => r.province },
      { label: "Trámite", render: (r) => r.tramite, class: "wrap" },
      {
        label: "Offices open",
        class: "wrap",
        render: (r) => ((r.offices || []).length ? (r.offices || []).map((o) => String(o.text || "").split(",")[0]).join("; ") : badge("None", "bad")),
      },
    ],
  },
  {
    id: "relayswitch-logs",
    title: "RelaySwitch log",
    path: "/relayswitch/logs",
    filters: [{ key: "level", label: "Level", options: Object.entries(LEVEL).map(([v, [t]]) => [v, t]) }],
    match: (r, f) => !f.level || r.level === f.level,
    text: (r) => [r.event, r.profile, r.detail],
    columns: () => [
      { label: "Time", render: (r) => fmtTime(r.t) },
      { label: "Level", render: (r) => pill(LEVEL, r.level) },
      { label: "Event", render: (r) => r.event },
      { label: "Proxy", render: (r) => r.profile },
      { label: "Detail", render: (r) => r.detail, class: "wrap" },
    ],
  },
];

let currentTab = TABS[0].id;

export default async function activityPage() {
  const root = el("div");
  const body = el("div");
  const tabBar = el("div", { class: "tabs", role: "tablist" });

  function renderTabs() {
    tabBar.textContent = "";
    for (const t of TABS) {
      tabBar.append(
        el("button", {
          type: "button",
          role: "tab",
          "aria-selected": String(t.id === currentTab),
          testid: "tab-" + t.id,
          onclick: () => { currentTab = t.id; renderTabs(); load(); },
        }, t.title),
      );
    }
  }

  async function load() {
    const tab = TABS.find((t) => t.id === currentTab);
    body.textContent = "";
    body.append(el("div", { class: "table-wrap" }, el("table", null, el("tbody", null, skeletonRows(6, 8)))));
    let items = [];
    try {
      items = (await get(tab.path + qs({ owner: ownerParam(), limit: 5000, ...(tab.query || {}) }))).items || [];
    } catch (e) {
      toastError(e);
    }
    items = items.slice().reverse(); // newest first
    const filterVals = {};
    const search = el("input", { type: "search", placeholder: "Search…", "aria-label": "Search", testid: "activity-search" });
    const selects = tab.filters.map((f) => {
      const s = el("select", { "aria-label": f.label, testid: "activity-filter-" + f.key });
      s.append(el("option", { value: "" }, "All – " + f.label.toLowerCase()));
      f.options.forEach(([v, t]) => s.append(el("option", { value: v }, t)));
      s.addEventListener("change", () => { filterVals[f.key] = s.value; draw(); });
      return s;
    });
    const clearBtn = el("button", {
      type: "button",
      class: "btn danger",
      testid: "activity-clear",
      onclick: async () => {
        if (!(await confirmDialog(`Clear your ${tab.title.toLowerCase()}? Other users' records are not touched.`, { okLabel: "Clear" }))) return;
        try {
          const r = await del(tab.path);
          toast(`Removed ${r.removed ?? 0} records.`, "ok");
          load();
        } catch (e) { toastError(e); }
      },
    }, "Clear my log");
    const listBox = el("div");
    let lastRows = [];
    // Errors with their page snapshots: what the current filters show, or every error when none is set.
    const exportBtn = tab.errors
      ? el("button", {
          type: "button",
          class: "btn",
          testid: "activity-export-errors",
          onclick: () => {
            const rows = filterVals.status ? lastRows : lastRows.filter(isError);
            if (!rows.length) return toast("No failed or stuck steps to export.", "error");
            exportErrorsCsv(rows, showOwner());
            toast(`Exported ${rows.length} error${rows.length === 1 ? "" : "s"}.`, "ok");
          },
        }, "Export errors (CSV)")
      : null;
    function draw() {
      const term = search.value.trim().toLowerCase();
      const rows = items.filter((r) => tab.match(r, filterVals)).filter((r) => !term || tab.text(r).some((v) => String(v || "").toLowerCase().includes(term)));
      const cols = tab.columns();
      if (showOwner()) cols.push({ label: "Owner", render: (r) => r.ownerName });
      lastRows = rows;
      const shown = rows.slice(0, 500);
      listBox.textContent = "";
      listBox.append(
        table(cols, shown, { testid: "activity-table", empty: items.length ? "Nothing matches the filters." : "No records yet." }),
        el("p", { class: "hint" }, `${rows.length} records` + (rows.length > shown.length ? ` (showing the newest ${shown.length})` : "")),
      );
    }
    search.addEventListener("input", draw);
    body.textContent = "";
    body.append(el("div", { class: "toolbar" }, search, selects, el("span", { class: "spacer" }), exportBtn, clearBtn), listBox);
    draw();
  }

  renderTabs();
  root.append(pageHead("Activity", ownerSelect(load)), tabBar, body);
  await load();
  return root;
}
