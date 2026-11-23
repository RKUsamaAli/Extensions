// RelaySwitch proxies.
import { get, post, put, del, qs } from "../api.js";
import { el, table, scrollTable, skeletonTiles, drawer, confirmDialog, toast, toastError, field, input, select, formValues, fmtTime, badge, ago } from "../ui.js";
import { scoreOf, scoreBand, SCORE_WINDOW } from "../proxyScore.js";
import { ownerParam, ownerSelect, pageHead, showOwner, ownerField, ownerCell, defaultOwnerId, isAdmin } from "../state.js";
import { parseProxyList } from "../proxyParse.js";

const SCHEMES = [
  { value: "http", text: "HTTP" },
  { value: "https", text: "HTTPS" },
  { value: "socks4", text: "SOCKS4" },
  { value: "socks5", text: "SOCKS5" },
];

function passwordField(value) {
  const inp = input("password", value, { type: "password", autocomplete: "new-password", testid: "proxy-password" });
  const btn = el("button", { type: "button", class: "btn small", "aria-label": "Show password", testid: "proxy-password-toggle" }, "Show");
  btn.addEventListener("click", () => {
    const show = inp.type === "password";
    inp.type = show ? "text" : "password";
    btn.textContent = show ? "Hide" : "Show";
    btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
  });
  return el("div", { class: "row" }, inp, btn);
}

function openEditor(p, onDone) {
  const x = p || { scheme: "http", sessionStart: 1, sessionEnd: 1000 };
  const body = el(
    "div",
    { class: "form-grid" },
    ownerField(p && p.ownerId, "proxy"),
    field("Name", input("name", x.name, { placeholder: "Defaults to host:port", testid: "proxy-name" }), { wide: true }),
    field("Type", select("scheme", SCHEMES, x.scheme || "http", { testid: "proxy-scheme" })),
    field("Host *", input("host", x.host, { required: true, autocapitalize: "none", spellcheck: "false", testid: "proxy-host" })),
    field("Port *", input("port", x.port, { type: "number", min: 1, max: 65535, required: true, testid: "proxy-port" })),
    field("Username", input("usernameTemplate", x.usernameTemplate, { autocapitalize: "none", spellcheck: "false", testid: "proxy-username" }), {
      wide: true,
      hint: "Plain username or a template with {session}, {country}, {city}.",
    }),
    el("label", { class: "wide" }, "Password", passwordField(x.password)),
    field("Country", input("country", x.country, { placeholder: "e.g. de", testid: "proxy-country" })),
    field("City", input("city", x.city, { testid: "proxy-city" })),
    field("Session from", input("sessionStart", x.sessionStart ?? 1, { type: "number", min: 0, testid: "proxy-sessionStart" })),
    field("Session to", input("sessionEnd", x.sessionEnd ?? 1000, { type: "number", min: 0, testid: "proxy-sessionEnd" })),
  );
  drawer({
    title: p ? "Edit proxy" : "Add proxy",
    body,
    testid: "proxy-drawer",
    async onSave(form) {
      const v = formValues(form);
      const data = {
        name: v.name.trim() || `${v.host.trim()}:${v.port}`,
        scheme: v.scheme,
        host: v.host.trim(),
        port: Number(v.port),
        usernameTemplate: v.usernameTemplate.trim(),
        password: v.password,
        country: v.country.trim(),
        city: v.city.trim(),
        sessionStart: Number(v.sessionStart) || 0,
        sessionEnd: Number(v.sessionEnd) || 0,
        ...(v.ownerId ? { ownerId: v.ownerId } : {}),
      };
      if (!data.host || !(data.port >= 1 && data.port <= 65535)) {
        const err = new Error("Host and a port between 1 and 65535 are required.");
        err.body = { fields: { ...(data.host ? {} : { host: "Required" }), ...(data.port >= 1 && data.port <= 65535 ? {} : { port: "1–65535" }) } };
        throw err;
      }
      if (p) await put("/relayswitch/proxies/" + encodeURIComponent(p.id), data);
      else await post("/relayswitch/proxies", data);
      toast(p ? "Proxy saved." : "Proxy added.", "ok");
      onDone();
    },
  });
}

function openBulk(onDone) {
  const area = el("textarea", { name: "list", rows: 12, class: "code", spellcheck: "false", testid: "proxy-bulk-text", placeholder: "1.2.3.4:8080:user:pass\nsocks5://user:pass@host:1080" });
  area.style.minHeight = "14rem";
  const preview = el("div", { class: "hint", testid: "proxy-bulk-preview" });
  const scheme = select("scheme", SCHEMES, "http", { testid: "proxy-bulk-scheme" });
  const update = () => {
    const { items, errors } = parseProxyList(area.value, scheme.value);
    preview.textContent = `${items.length} proxies ready` + (errors.length ? `, ${errors.length} lines can't be read: ` + errors.slice(0, 5).map((e) => `line ${e.line} (${e.message})`).join("; ") : "");
  };
  area.addEventListener("input", update);
  scheme.addEventListener("change", update);
  drawer({
    title: "Bulk add proxies",
    saveLabel: "Add all",
    testid: "proxy-bulk-drawer",
    body: el(
      "div",
      { class: "stack" },
      el("p", { class: "hint" }, "One proxy per line: host:port, host:port:user:pass, user:pass@host:port or scheme://user:pass@host:port. Lines starting with # are skipped."),
      ownerField(null, "proxies"),
      field("Type for lines without a scheme", scheme),
      field("Proxies", area),
      preview,
    ),
    async onSave() {
      const { items, errors } = parseProxyList(area.value, scheme.value);
      if (!items.length) throw new Error(errors.length ? `No line could be read (line ${errors[0].line}: ${errors[0].message}).` : "Paste at least one proxy.");
      if (items.length > 1000) throw new Error("At most 1000 proxies at once.");
      const ownerSel = document.querySelector('[data-testid=proxy-bulk-drawer] select[name=ownerId]');
      const r = await post("/relayswitch/proxies/bulk", { items, ...(isAdmin() ? { ownerId: ownerSel ? ownerSel.value : defaultOwnerId() } : {}) });
      toast(`Added ${(r.items || []).length} proxies.` + (errors.length ? ` ${errors.length} lines skipped.` : ""), "ok");
      onDone();
    },
  });
}

const BAND = { good: ["Good", "ok"], fair: ["Fair", "warn"], poor: ["Poor", "bad"], none: ["Not checked", ""] };
const pct = (x) => Math.round(x * 100) + "%";

function scoreBadge(sc) {
  const band = scoreBand(sc.value);
  if (band === "none") return badge("Not checked");
  return badge(`${sc.value} · ${BAND[band][0]}`, BAND[band][1]);
}

/** Bars for the recent checks: height = speed, colour = result (newest on the right). */
function sparkline(results) {
  const bars = el("span", { class: "spark", "aria-hidden": "true" });
  for (const r of results.slice(-SCORE_WINDOW)) {
    const b = el("span", { class: "spark-bar " + (r.ok ? "ok" : "bad") });
    const h = r.ok && typeof r.ms === "number" ? Math.max(20, Math.min(100, 100 - (r.ms / 3000) * 80)) : 100;
    b.style.height = h + "%"; // CSSOM, allowed by the panel's CSP
    b.title = `${fmtTime(r.t)} · ${r.ok ? (r.ms ?? "?") + " ms" : "failed" + (r.error ? ": " + r.error : "")}`;
    bars.append(b);
  }
  return bars;
}

function openHistory(p, results) {
  const sc = scoreOf(results);
  const rows = results.slice().reverse();
  const stat = (label, value, testid) => el("div", { class: "stat-mini", testid }, el("span", { class: "hint" }, label), el("b", null, value));
  drawer({
    title: `Check history · ${p.name}`,
    saveLabel: "Done",
    wide: true,
    testid: "proxy-history",
    body: el(
      "div",
      { class: "stack wide-stack" },
      el(
        "div",
        { class: "stat-row" },
        stat("Score", sc.value === null ? "—" : `${sc.value} / 100`, "history-score"),
        stat(`Success (last ${sc.samples})`, sc.samples ? `${sc.okCount}/${sc.samples} · ${pct(sc.reliability)}` : "—", "history-success"),
        stat("Median speed", sc.medianMs === null ? "—" : sc.medianMs + " ms", "history-speed"),
        stat("Exit IP", sc.lastIp || "—", "history-ip"),
      ),
      results.length ? sparkline(results) : null,
      el("p", { class: "hint" }, `Score: ${SCORE_WINDOW} latest checks — 70 points for how often it works, 30 for speed (0.3 s or faster = full, 3 s or slower = none), minus 15 if the latest check failed. The server keeps the last 50 checks.`),
      table(
        [
          { label: "Time", render: (r) => fmtTime(r.t) },
          { label: "Result", render: (r) => (r.ok ? badge("OK", "ok") : badge("Failed", "bad")) },
          { label: "Response", render: (r) => (typeof r.ms === "number" ? r.ms + " ms" : "") },
          { label: "Exit IP", render: (r) => (r.ip ? el("span", { class: "mono" }, r.ip) : "") },
          { label: "Error", render: (r) => r.error, class: "wrap" },
          { label: "Source", render: (r) => r.source },
        ],
        rows,
        { testid: "history-table", empty: "No checks yet. Run Test in the RelaySwitch extension." },
      ),
    ),
    onSave: () => {},
  });
}

const FILTERS = [
  ["", "All"],
  ["good", "Good (80+)"],
  ["fair", "Fair (50–79)"],
  ["poor", "Poor (<50)"],
  ["failing", "Latest check failed"],
  ["none", "Not checked"],
];
const SORTS = [
  ["score", "Best score"],
  ["speed", "Fastest"],
  ["recent", "Recently checked"],
  ["name", "Name"],
];

const PAGE = 50;

export default async function proxiesPage() {
  const root = el("div");
  const search = el("input", { type: "search", placeholder: "Search name, host, username, IP…", "aria-label": "Search proxies", testid: "proxies-search" });
  const filter = el("select", { "aria-label": "Show", testid: "proxies-filter" }, FILTERS.map(([v, t]) => el("option", { value: v }, t)));
  const sortSel = el("select", { "aria-label": "Sort by", testid: "proxies-sort" }, SORTS.map(([v, t]) => el("option", { value: v }, "Sort: " + t)));
  const summary = el("div", { class: "grid summary-grid", testid: "proxies-summary" });
  const countLine = el("p", { class: "hint list-foot", testid: "proxies-count" });
  const listBox = el("div");

  /** Tiles: always the whole list (server summary), whatever the search or filter. */
  function renderSummary(m) {
    const tile = (n, label, note, testid, kind) => el("div", { class: "card stat" + (kind ? " " + kind : ""), testid }, el("b", null, n), el("span", null, label), el("small", null, note || " "));
    summary.textContent = "";
    summary.append(
      tile(String(m.total), "Proxies", "in this list", "sum-total"),
      tile(String(m.checked), "Checked", m.neverChecked ? `${m.neverChecked} not checked yet` : "all checked", "sum-checked"),
      tile(String(m.good), "Healthy", "score 80 or more", "sum-good", m.good ? "good" : ""),
      tile(String(m.failing), "Failing", "latest check failed", "sum-failing", m.failing ? "bad" : ""),
      tile(m.successRatio === null ? "—" : pct(m.successRatio), "Success rate", m.lastChecked ? "last check " + ago(m.lastChecked) : "no checks yet", "sum-success"),
      tile(m.medianMs === null ? "—" : m.medianMs + " ms", "Response time", "median, OK checks", "sum-speed"),
    );
  }

  async function showHistory(r) {
    try {
      const c = await get("/relayswitch/checks" + qs({ owner: ownerParam(), proxyId: r.id }));
      openHistory(r, (c.stats && c.stats[r.id] && c.stats[r.id].results) || []);
    } catch (e) { toastError(e); }
  }

  const columns = () => {
    const cols = [
      { label: "Name", render: (r) => el("div", null, el("strong", null, r.name), r.usernameTemplate ? el("div", { class: "mono hint nowrap" }, r.usernameTemplate) : null) },
      { label: "Server", render: (r) => el("div", null, el("span", { class: "mono nowrap" }, `${r.host}:${r.port}`),
        el("div", { class: "hint" }, [String(r.scheme || "").toUpperCase(), [r.country, r.city].filter(Boolean).join(" / ").toUpperCase()].filter(Boolean).join(" · "))) },
      { label: "Score", class: "nowrap", render: (r) => scoreBadge(r.score) },
      { label: "Success", class: "nowrap", render: ({ score: sc }) => (sc.samples ? el("span", { title: `${sc.okCount} of the last ${sc.samples} checks worked` }, pct(sc.reliability), el("div", { class: "hint" }, `${sc.okCount}/${sc.samples} OK`)) : "") },
      { label: "Speed", class: "nowrap", render: ({ score: sc }) => (sc.medianMs === null ? "" : sc.medianMs + " ms") },
      { label: "Recent", render: (r) => (r.recent && r.recent.length ? sparkline(r.recent) : "") },
      {
        label: "Last check",
        class: "nowrap",
        render: ({ score: sc }) => {
          if (!sc.samples) return badge("Not checked");
          // Two lines at most: status + age, then the error (failed) or the exit IP (working).
          const second = !sc.lastOk && sc.lastError
            ? el("div", { class: "hint ellipsis", title: sc.lastError }, sc.lastError)
            : sc.lastIp ? el("div", { class: "mono hint", title: "Exit IP of the last working check" }, sc.lastIp) : null;
          return el("span", null, sc.lastOk ? badge("OK", "ok") : badge("Failed", "bad"), " ", el("span", { class: "hint", title: fmtTime(sc.lastChecked) }, ago(sc.lastChecked)), second);
        },
      },
    ];
    if (showOwner()) cols.push({ label: "Owner", render: ownerCell });
    cols.push({
      label: "",
      class: "actions",
      render: (r) =>
        el(
          "span",
          null,
          el("button", { type: "button", class: "btn small", testid: "row-history", onclick: () => showHistory(r) }, "History"),
          el("button", { type: "button", class: "btn small", testid: "row-edit", onclick: () => openEditor(r, load) }, "Edit"),
          el("button", {
            type: "button",
            class: "btn small danger",
            testid: "row-delete",
            onclick: async () => {
              if (!(await confirmDialog(`Delete the proxy "${r.name}"?`))) return;
              try {
                await del("/relayswitch/proxies/" + encodeURIComponent(r.id));
                toast("Proxy deleted.", "ok");
                load();
              } catch (e) { toastError(e); }
            },
          }, "Delete"),
        ),
    });
    return cols;
  };

  function load() {
    listBox.textContent = "";
    if (!summary.childElementCount) summary.append(...skeletonTiles(6));
    countLine.textContent = "";
    const term = search.value.trim();
    const list = scrollTable(columns(), {
      testid: "proxies-table",
      empty: term || filter.value ? "No proxy matches the search or filter." : "No proxies yet. Add one or paste a list.",
      fetchPage: async (offset = 0) => {
        const r = await get("/relayswitch/proxies" + qs({ owner: ownerParam(), q: term, filter: filter.value, sort: sortSel.value, limit: PAGE, offset }));
        if (offset === 0) renderSummary(r.summary);
        return { items: r.items || [], next: r.nextOffset, total: r.total };
      },
      onPage: ({ loaded, total }) => {
        countLine.textContent = `Showing ${loaded} of ${total}${total !== undefined && (term || filter.value) ? " matching" : ""} proxies. Checks run in the RelaySwitch extension (Test / Test all on its options page, and while a proxy is in use); this page shows their results.`;
      },
    });
    listBox.append(list);
  }

  let searchTimer = 0;
  search.addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(load, 250); });
  filter.addEventListener("change", load);
  sortSel.addEventListener("change", load);
  root.append(
    pageHead(
      "RelaySwitch proxies",
      ownerSelect(load, { created: true }),
      el("button", { type: "button", class: "btn", testid: "proxy-refresh", onclick: () => load() }, "Refresh"),
      el("button", { type: "button", class: "btn", testid: "proxy-bulk", onclick: () => openBulk(load) }, "Bulk add"),
      el("button", { type: "button", class: "btn primary", testid: "proxy-add", onclick: () => openEditor(null, load) }, "Add proxy"),
    ),
    summary,
    el("div", { class: "toolbar" }, search, filter, sortSel),
    listBox,
    countLine,
  );
  load();
  return root;
}
