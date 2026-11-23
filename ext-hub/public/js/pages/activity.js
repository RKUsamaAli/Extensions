// Activity: CitaMate logs, office sightings, RelaySwitch logs.
import { get, del, qs } from "../api.js";
import { el, table, toast, toastError, confirmDialog, fmtTime, badge, skeletonRows } from "../ui.js";
import { ownerParam, ownerSelect, pageHead, showOwner } from "../state.js";

const STATUS = { done: ["Done", "ok"], ok: ["OK", "ok"], fail: ["Failed", "bad"], stuck: ["Stuck", "warn"], wait: ["Waiting", "warn"], info: ["Info", "info"], run: ["Running", "info"] };
const LEVEL = { info: ["Info", "info"], warn: ["Warning", "warn"], error: ["Error", "bad"] };
const pill = (map, k) => (map[k] ? badge(map[k][0], map[k][1]) : badge(k || "—"));

const TABS = [
  {
    id: "citamate-logs",
    title: "CitaMate log",
    path: "/citamate/logs",
    filters: [
      { key: "status", label: "Result", options: Object.entries(STATUS).map(([v, [t]]) => [v, t]) },
      { key: "kind", label: "Type", options: [["booking", "Booking"], ["check", "Office check"]] },
    ],
    match: (r, f) => (!f.status || r.status === f.status) && (!f.kind || (r.kind || "booking") === f.kind),
    text: (r) => [r.entry, r.page, r.action, r.detail, r.url],
    columns: () => [
      { label: "Time", render: (r) => fmtTime(r.t) },
      { label: "Result", render: (r) => pill(STATUS, r.status) },
      { label: "Entry", render: (r) => r.entry },
      { label: "Page", render: (r) => r.page },
      { label: "Action", render: (r) => r.action },
      { label: "Detail", render: (r) => r.detail, class: "wrap" },
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
      items = (await get(tab.path + qs({ owner: ownerParam(), limit: 5000 }))).items || [];
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
    function draw() {
      const term = search.value.trim().toLowerCase();
      const rows = items.filter((r) => tab.match(r, filterVals)).filter((r) => !term || tab.text(r).some((v) => String(v || "").toLowerCase().includes(term)));
      const cols = tab.columns();
      if (showOwner()) cols.push({ label: "Owner", render: (r) => r.ownerName });
      const shown = rows.slice(0, 500);
      listBox.textContent = "";
      listBox.append(
        table(cols, shown, { testid: "activity-table", empty: items.length ? "Nothing matches the filters." : "No records yet." }),
        el("p", { class: "hint" }, `${rows.length} records` + (rows.length > shown.length ? ` (showing the newest ${shown.length})` : "")),
      );
    }
    search.addEventListener("input", draw);
    body.textContent = "";
    body.append(el("div", { class: "toolbar" }, search, selects, el("span", { class: "spacer" }), clearBtn), listBox);
    draw();
  }

  renderTabs();
  root.append(pageHead("Activity", ownerSelect(load)), tabBar, body);
  await load();
  return root;
}
