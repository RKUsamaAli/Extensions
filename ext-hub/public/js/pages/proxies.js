// RelaySwitch proxies.
import { get, post, put, del, qs } from "../api.js";
import { el, table, drawer, confirmDialog, toast, toastError, field, input, select, formValues, fmtTime, badge, ago } from "../ui.js";
import { scoreOf, scoreBand, SCORE_WINDOW } from "../proxyScore.js";
import { ownerParam, ownerSelect, pageHead, showOwner } from "../state.js";
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
      field("Type for lines without a scheme", scheme),
      field("Proxies", area),
      preview,
    ),
    async onSave() {
      const { items, errors } = parseProxyList(area.value, scheme.value);
      if (!items.length) throw new Error(errors.length ? `No line could be read (line ${errors[0].line}: ${errors[0].message}).` : "Paste at least one proxy.");
      if (items.length > 1000) throw new Error("At most 1000 proxies at once.");
      const r = await post("/relayswitch/proxies/bulk", { items });
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

export default async function proxiesPage() {
  const root = el("div");
  let items = [];
  let stats = {};
  const search = el("input", { type: "search", placeholder: "Search name, host, username, IP…", "aria-label": "Search proxies", testid: "proxies-search" });
  const filter = el("select", { "aria-label": "Show", testid: "proxies-filter" }, FILTERS.map(([v, t]) => el("option", { value: v }, t)));
  const sortSel = el("select", { "aria-label": "Sort by", testid: "proxies-sort" }, SORTS.map(([v, t]) => el("option", { value: v }, "Sort: " + t)));
  const summary = el("div", { class: "grid summary-grid", testid: "proxies-summary" });
  const listBox = el("div");

  const resultsOf = (id) => (stats[id] && stats[id].results) || [];

  function renderSummary(scored) {
    const checked = scored.filter((x) => x.sc.samples);
    const good = checked.filter((x) => scoreBand(x.sc.value) === "good").length;
    const failing = checked.filter((x) => x.sc.lastOk === false).length;
    const totalOk = checked.reduce((n, x) => n + x.sc.okCount, 0);
    const totalSamples = checked.reduce((n, x) => n + x.sc.samples, 0);
    const speeds = checked.map((x) => x.sc.medianMs).filter((v) => v !== null).sort((a, b) => a - b);
    const tile = (n, label, note, testid, kind) => el("div", { class: "card stat" + (kind ? " " + kind : ""), testid }, el("b", null, n), el("span", null, label), el("small", null, note || "\u00a0"));
    const never = items.length - checked.length;
    summary.textContent = "";
    summary.append(
      tile(String(items.length), "Proxies", "in this list", "sum-total"),
      tile(String(checked.length), "Checked", never ? `${never} not checked yet` : "all checked", "sum-checked"),
      tile(String(good), "Healthy", "score 80 or more", "sum-good", good ? "good" : ""),
      tile(String(failing), "Failing", "latest check failed", "sum-failing", failing ? "bad" : ""),
      tile(totalSamples ? pct(totalOk / totalSamples) : "—", "Success rate", totalSamples ? `${totalOk} of ${totalSamples} checks` : "no checks yet", "sum-success"),
      tile(speeds.length ? speeds[Math.floor(speeds.length / 2)] + " ms" : "—", "Response time", "median, OK checks", "sum-speed"),
    );
  }

  function renderList() {
    const term = search.value.trim().toLowerCase();
    const scored = items.map((r) => ({ r, sc: scoreOf(resultsOf(r.id)) }));
    renderSummary(scored);
    const f = filter.value;
    let rows = scored.filter(({ r, sc }) => {
      if (term && ![r.name, r.host, r.usernameTemplate, r.country, r.city, r.ownerName, sc.lastIp].some((v) => String(v || "").toLowerCase().includes(term))) return false;
      if (!f) return true;
      if (f === "failing") return sc.lastOk === false;
      return scoreBand(sc.value) === f;
    });
    const by = sortSel.value;
    const nullsLast = (a, b, fn) => (a === null) - (b === null) || (a === null ? 0 : fn(a, b));
    rows = rows.slice().sort((a, b) => {
      if (by === "name") return a.r.name.localeCompare(b.r.name, undefined, { numeric: true });
      if (by === "speed") return nullsLast(a.sc.medianMs, b.sc.medianMs, (x, y) => x - y);
      if (by === "recent") return nullsLast(a.sc.lastChecked, b.sc.lastChecked, (x, y) => y - x);
      return nullsLast(a.sc.value, b.sc.value, (x, y) => y - x) || a.r.name.localeCompare(b.r.name, undefined, { numeric: true });
    });
    const cols = [
      { label: "Name", render: ({ r }) => el("div", null, el("strong", null, r.name), r.usernameTemplate ? el("div", { class: "mono hint nowrap" }, r.usernameTemplate) : null) },
      { label: "Server", render: ({ r }) => el("div", null, el("span", { class: "mono nowrap" }, `${r.host}:${r.port}`),
        el("div", { class: "hint" }, [String(r.scheme || "").toUpperCase(), [r.country, r.city].filter(Boolean).join(" / ").toUpperCase()].filter(Boolean).join(" · "))) },
      { label: "Score", render: ({ sc }) => scoreBadge(sc) },
      { label: "Success", class: "nowrap", render: ({ sc }) => (sc.samples ? el("span", { title: `${sc.okCount} of the last ${sc.samples} checks worked` }, pct(sc.reliability), el("div", { class: "hint" }, `${sc.okCount}/${sc.samples} OK`)) : "") },
      { label: "Speed", class: "nowrap", render: ({ sc }) => (sc.medianMs === null ? "" : sc.medianMs + " ms") },
      { label: "Recent", render: ({ r }) => (resultsOf(r.id).length ? sparkline(resultsOf(r.id)) : "") },
      {
        label: "Last check",
        class: "nowrap",
        render: ({ sc }) => {
          if (!sc.samples) return badge("Not checked");
          return el("span", null, sc.lastOk ? badge("OK", "ok") : badge("Failed", "bad"), " ", el("span", { class: "hint", title: fmtTime(sc.lastChecked) }, ago(sc.lastChecked)),
            !sc.lastOk && sc.lastError ? el("div", { class: "hint" }, sc.lastError) : null,
            sc.lastIp ? el("div", { class: "mono hint", title: "Exit IP of the last working check" }, sc.lastIp) : null);
        },
      },
    ];
    if (showOwner()) cols.push({ label: "Owner", render: ({ r }) => r.ownerName });
    cols.push({
      label: "",
      class: "actions",
      render: ({ r }) =>
        el(
          "span",
          null,
          el("button", { type: "button", class: "btn small", testid: "row-history", onclick: () => openHistory(r, resultsOf(r.id)) }, "History"),
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
    listBox.textContent = "";
    listBox.append(
      table(cols, rows, { testid: "proxies-table", empty: items.length ? "No proxy matches the search or filter." : "No proxies yet. Add one or paste a list." }),
      el("p", { class: "hint" }, `${rows.length} of ${items.length} proxies. Checks run in the RelaySwitch extension (Test / Test all on its options page, and while a proxy is in use); this page shows their results.`),
    );
  }

  async function load() {
    const q = qs({ owner: ownerParam() });
    try {
      const [p, c] = await Promise.all([get("/relayswitch/proxies" + q), get("/relayswitch/checks" + q).catch(() => ({ stats: {} }))]);
      items = p.items || [];
      stats = c.stats || {};
    } catch (e) {
      items = [];
      toastError(e);
    }
    renderList();
  }

  let searchTimer = 0;
  search.addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(renderList, 150); });
  filter.addEventListener("change", renderList);
  sortSel.addEventListener("change", renderList);
  root.append(
    pageHead(
      "RelaySwitch proxies",
      ownerSelect(load),
      el("button", { type: "button", class: "btn", testid: "proxy-refresh", onclick: () => load() }, "Refresh"),
      el("button", { type: "button", class: "btn", testid: "proxy-bulk", onclick: () => openBulk(load) }, "Bulk add"),
      el("button", { type: "button", class: "btn primary", testid: "proxy-add", onclick: () => openEditor(null, load) }, "Add proxy"),
    ),
    summary,
    el("div", { class: "toolbar" }, search, filter, sortSel),
    listBox,
  );
  await load();
  return root;
}
