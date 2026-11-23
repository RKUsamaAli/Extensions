import { bulkNames, parseBulk, proxyKey, type BulkResult, type NameBy } from "../core/bulk";
import { formatAgo, formatDuration } from "../core/format";
import { isValidHost, parsePort, parseProxyLine } from "../core/parse";
import { displayName } from "../core/profile";
import { scoreBand, scoreOf, type Score } from "../core/score";
import type { LogEntry, ProxyProfile, ProxyStats, Scheme } from "../core/types";
import { renderUsername, templateTokens, usesSession } from "../core/username";
import { send, type Message } from "../shared/messages";
import type { TestRun } from "../shared/storage";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const val = (id: string) => $<HTMLInputElement>(id).value.trim();
const setVal = (id: string, v: string | number) => ($<HTMLInputElement>(id).value = String(v));
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const SEARCH_MIN = 5; // search shows only when there are more proxies than this
const LOG_SHOWN = 200;

let profiles: ProxyProfile[] = [];
let stats: Record<string, ProxyStats> = {};
let activeId: string | null = null;
/** True only while RelaySwitch is on and connected through the selected proxy. */
let connected = false;
let enabled = false;
let editingId: string | null = null;
let testing = false;

// ---------- talking to the worker ----------

async function run(msg: Message): Promise<boolean> {
  let reply;
  try {
    reply = await send(msg);
    if (!reply) throw new Error("No answer from the extension. Reload it in chrome://extensions.");
  } catch (err) {
    reply = { ok: false as const, error: err instanceof Error ? err.message : String(err) };
  }
  if (!reply.ok) {
    $("loadingList").hidden = true;
    // Form errors go next to the open form; anything else at the top.
    if (!$("editor").hidden) showError(reply.error);
    else showPageError(reply.error);
    return false;
  }
  $("pageError").hidden = true;
  const { canProxy, missing, limited } = reply.support;
  $("unsupported").hidden = canProxy;
  $("unsupported").textContent = canProxy
    ? ""
    : `This browser can't run RelaySwitch: it has no ${missing.join(" or ") || "proxy support"}. ` +
      "You can still add and edit proxies here, but turning a proxy on and testing need Chrome, Edge, Brave, Opera or Arc.";
  $("limited").hidden = !canProxy || limited.length === 0;
  $("limited").textContent = limited.length ? `Not available in this browser: ${limited.join(", ")}.` : "";
  $<HTMLButtonElement>("testAllBtn").dataset.unsupported = String(!canProxy);
  profiles = reply.profiles;
  activeId = reply.state.activeProfileId;
  enabled = reply.state.enabled;
  connected = reply.state.enabled && reply.state.status === "connected";
  $<HTMLInputElement>("fabToggle").checked = reply.settings.floatingButton;
  await loadStats();
  renderList();
  renderLogFilter();
  await renderLogs();
  return true;
}

function showPageError(text: string): void {
  $("pageError").textContent = text;
  $("pageError").hidden = false;
  $("pageError").scrollIntoView({ block: "nearest" });
}

async function loadStats(): Promise<void> {
  const data = (await chrome.storage.local.get("stats")) as { stats?: Record<string, ProxyStats> };
  stats = data.stats ?? {};
}

const scoreFor = (id: string): Score => scoreOf(stats[id]?.results ?? []);

// ---------- proxy list ----------

function sorted(list: ProxyProfile[]): ProxyProfile[] {
  const by = val("sort");
  const withScore = list.map((p, i) => ({ p, i, s: scoreFor(p.id) }));
  withScore.sort((a, b) => {
    if (by === "name") return displayName(a.p).localeCompare(displayName(b.p));
    if (by === "added") return a.i - b.i;
    if (by === "speed") return (a.s.medianMs ?? Infinity) - (b.s.medianMs ?? Infinity) || a.i - b.i;
    // Best score first; untested proxies last.
    return (b.s.value ?? -1) - (a.s.value ?? -1) || a.i - b.i;
  });
  return withScore.map((x) => x.p);
}

function renderList(): void {
  $("loadingList").hidden = true;
  $("noProfiles").hidden = profiles.length > 0;
  $("count").textContent = profiles.length ? `(${profiles.length})` : "";
  const noProxy = $<HTMLButtonElement>("testAllBtn").dataset.unsupported === "true";
  $<HTMLButtonElement>("testAllBtn").disabled = testing || profiles.length === 0 || noProxy;

  const search = $<HTMLInputElement>("search");
  search.hidden = profiles.length <= SEARCH_MIN;
  if (search.hidden) search.value = "";
  const q = search.value.trim().toLowerCase();
  const shown = q
    ? profiles.filter((p) =>
        [displayName(p), p.usernameTemplate, p.host, p.country, p.city, scoreFor(p.id).lastIp ?? ""].some((f) =>
          f.toLowerCase().includes(q),
        ),
      )
    : profiles;
  $("noMatch").hidden = !q || shown.length > 0;
  $("list").replaceChildren(...sorted(shown).map(row));
}

function scoreBadge(s: Score): HTMLElement {
  const b = el("span", `score ${scoreBand(s.value)}`, s.value === null ? "–" : String(s.value));
  b.title =
    s.value === null
      ? "Not tested yet"
      : `Score ${s.value}/100 · works ${Math.round((s.reliability ?? 0) * 100)}% of ${s.samples} checks · median ${formatDuration(s.medianMs)}`;
  return b;
}

function row(p: ProxyProfile): HTMLLIElement {
  const s = scoreFor(p.id);
  const li = el("li");
  const isSelected = p.id === activeId;
  if (isSelected && enabled) li.classList.add(connected ? "connected" : "connecting");

  const main = el("div", "main");
  const title = el("div", "title");
  title.append(el("strong", "", displayName(p)));
  if (isSelected) {
    // "Connected" only while traffic really goes through it; otherwise it is
    // just the proxy that will be used when RelaySwitch is turned on.
    const [cls, text, tip] = !enabled
      ? ["badge idle", "Selected", "Used when you turn RelaySwitch on"]
      : connected
        ? ["badge", "Connected", "Your traffic goes through this proxy now"]
        : ["badge warn", "Connecting…", "Turning on or checking the connection"];
    const b = el("span", cls, text);
    b.title = tip;
    title.append(b);
  }
  main.append(title, el("div", "mono muted addr", `${p.scheme}://${p.host}:${p.port}`));

  const meta = el("div", "meta muted");
  if (s.value === null) {
    meta.textContent = "Not tested yet";
  } else {
    const parts = [
      s.medianMs !== null ? formatDuration(s.medianMs) : "no answer",
      `${Math.round((s.reliability ?? 0) * 100)}% ok`,
      s.lastIp ? `IP ${s.lastIp}` : "",
      formatAgo(s.lastChecked),
    ].filter(Boolean);
    meta.textContent = parts.join(" · ");
    if (s.lastOk === false) {
      const last = stats[p.id]?.results.at(-1);
      meta.append(el("span", "error", ` · last check failed${last?.error ? `: ${last.error}` : ""}`));
    }
  }
  main.append(meta);

  const actions = el("div", "actions");
  const test = el("button", "", "Test");
  test.disabled = testing || $<HTMLButtonElement>("testAllBtn").dataset.unsupported === "true";
  test.addEventListener("click", () => void startTest([p.id]));
  const logs = el("button", "", "Logs");
  logs.addEventListener("click", () => showLogsFor(p.id));
  const edit = el("button", "", "Edit");
  edit.addEventListener("click", () => openEditor(p));
  actions.append(test, logs, edit);

  li.append(scoreBadge(s), main, actions);
  return li;
}

// ---------- testing ----------

async function startTest(ids?: string[]): Promise<void> {
  const ok = await run({ type: "testProxies", ids });
  if (ok) await syncTestRun();
}

async function syncTestRun(): Promise<void> {
  const { testRun } = (await chrome.storage.session.get("testRun")) as { testRun?: TestRun | null };
  renderTestRun(testRun ?? null);
}

function renderTestRun(run: TestRun | null): void {
  const wasTesting = testing;
  testing = !!run?.running;
  $("testProgress").hidden = !testing;
  if (run && testing) {
    const current = profiles.find((p) => p.id === run.currentId);
    const elapsed = Date.now() - run.startedAt;
    $("testText").textContent =
      `${run.cancelled ? "Stopping…" : "Testing"} ${Math.min(run.done + 1, run.total)} of ${run.total}` +
      (current ? ` · ${displayName(current)}` : "") +
      ` · ${formatDuration(elapsed)}`;
    $("testBar").style.width = `${Math.round((run.done / run.total) * 100)}%`;
  }
  if (wasTesting !== testing) renderList();
}

// ---------- activity ----------

function renderLogFilter(): void {
  const select = $<HTMLSelectElement>("logFilter");
  const current = select.value;
  const opts = [new Option("All proxies", "")];
  for (const p of [...profiles].sort((a, b) => displayName(a).localeCompare(displayName(b)))) {
    opts.push(new Option(displayName(p), p.id));
  }
  select.replaceChildren(...opts);
  select.value = profiles.some((p) => p.id === current) ? current : "";
}

function showLogsFor(id: string): void {
  $<HTMLSelectElement>("logFilter").value = id;
  void renderLogs();
  $("activity").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function renderLogs(): Promise<void> {
  const { logs = [] } = (await chrome.storage.local.get("logs")) as { logs?: LogEntry[] };
  const id = val("logFilter");
  const p = profiles.find((x) => x.id === id);
  // Older entries have no profileId; match them by name.
  const mine = p ? logs.filter((l) => l.profileId === id || (!l.profileId && l.profile === displayName(p))) : logs;

  renderSummary(p);
  $("noLogs").hidden = mine.length > 0;
  $("logs").replaceChildren(
    ...mine
      .slice(-LOG_SHOWN)
      .reverse()
      .map((l) => {
        const li = el("li", l.level);
        const time = new Date(l.t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
        li.append(el("span", "muted", time), document.createTextNode(" "), el("strong", "", l.event.replace(/_/g, " ")));
        const rest = [p ? "" : l.profile, l.detail].filter(Boolean).join(" · ");
        if (rest) li.append(document.createTextNode(` · ${rest}`));
        return li;
      }),
  );
}

function renderSummary(p: ProxyProfile | undefined): void {
  const box = $("proxySummary");
  box.hidden = !p;
  if (!p) return;
  const s = scoreFor(p.id);
  const results = stats[p.id]?.results ?? [];
  const tested = results.filter((r) => r.source === "test").length;
  const items: [string, string][] = [
    ["Score", s.value === null ? "Not tested" : `${s.value}/100`],
    ["Works", s.reliability === null ? "–" : `${Math.round(s.reliability * 100)}% of last ${s.samples}`],
    ["Median time", formatDuration(s.medianMs)],
    ["Last IP", s.lastIp ?? "–"],
    ["Last check", formatAgo(s.lastChecked)],
    ["Checks kept", `${results.length} (${tested} tests, ${results.length - tested} while browsing)`],
  ];
  box.replaceChildren(
    scoreBadge(s),
    ...items.map(([k, v]) => {
      const d = el("div");
      d.append(el("span", "muted", k), el("strong", "", v));
      return d;
    }),
  );
}

// ---------- single editor ----------

function openEditor(p?: ProxyProfile): void {
  $("bulk").hidden = true;
  editingId = p?.id ?? null;
  $("editorTitle").textContent = p ? `Edit ${displayName(p)}` : "Add proxy";
  setVal("paste", "");
  setVal("name", p?.name ?? "");
  setVal("scheme", p?.scheme ?? "http");
  setVal("host", p?.host ?? "");
  setVal("port", p?.port ?? "");
  setVal("user", p?.usernameTemplate ?? "");
  setVal("pass", p?.password ?? "");
  setVal("country", p?.country ?? "");
  setVal("city", p?.city ?? "");
  setVal("sStart", p?.sessionStart ?? 1000);
  setVal("sEnd", p?.sessionEnd ?? 1999);
  $("deleteBtn").hidden = !p;
  $("formError").hidden = true;
  $("editor").hidden = false;
  updateSocksWarning();
  $("editor").scrollIntoView({ behavior: "smooth", block: "start" });
  $("name").focus({ preventScroll: true });
}

function showError(text: string): void {
  const e = $("formError");
  e.textContent = text;
  e.hidden = false;
}

function updateSocksWarning(): void {
  $("socksWarn").hidden = !(val("scheme").startsWith("socks") && val("pass") !== "");
}

function readForm(): ProxyProfile {
  const host = val("host");
  if (!isValidHost(host)) throw new Error(`Invalid host: ${host}`);
  const template = val("user");
  const profile: ProxyProfile = {
    id: editingId ?? crypto.randomUUID(),
    name: val("name"), // empty = show the username (see displayName)
    scheme: val("scheme") as Scheme,
    host,
    port: parsePort(val("port")),
    usernameTemplate: template,
    password: $<HTMLInputElement>("pass").value, // keep spaces, passwords are exact
    country: val("country").toLowerCase(),
    city: val("city").toLowerCase(),
    sessionStart: Number(val("sStart") || 0),
    sessionEnd: Number(val("sEnd") || 0),
  };
  if (usesSession(template) && profile.sessionEnd < profile.sessionStart) {
    throw new Error("Session 'to' must be at least 'from'");
  }
  // Validate the template now, with sample values, so errors show here.
  if (templateTokens(template).length) {
    renderUsername(template, { session: profile.sessionStart, country: profile.country, city: profile.city });
  }
  return profile;
}

function setSaving(on: boolean): void {
  $<HTMLButtonElement>("saveBtn").disabled = on;
  $("saveSpin").hidden = !on;
  // Saving the active proxy reconnects and re-checks the IP, which takes a moment.
  $("saveText").textContent = on ? "Saving…" : "Save";
}

// ---------- bulk add ----------

let bulkParsed: BulkResult | null = null;

function openBulk(): void {
  $("editor").hidden = true;
  $("bulk").hidden = false;
  previewBulk();
  $("bulk").scrollIntoView({ behavior: "smooth", block: "start" });
  $("bulkText").focus({ preventScroll: true });
}

function previewBulk(): void {
  const existing = new Set(profiles.map((p) => proxyKey({ host: p.host, port: p.port, username: p.usernameTemplate })));
  bulkParsed = parseBulk($<HTMLTextAreaElement>("bulkText").value, val("bulkScheme") as Scheme, existing);
  const { proxies, errors, duplicates } = bulkParsed;
  const parts = [`${proxies.length} ready to add`];
  if (duplicates) parts.push(`${duplicates} duplicate${duplicates === 1 ? "" : "s"} skipped`);
  if (errors.length) parts.push(`${errors.length} line${errors.length === 1 ? "" : "s"} with errors`);
  $("bulkSummary").textContent = $<HTMLTextAreaElement>("bulkText").value.trim() ? parts.join(" · ") : "";
  $("bulkErrors").replaceChildren(
    ...errors.slice(0, 20).map((e) => el("li", "error", `Line ${e.line}: ${e.error} — ${e.text.slice(0, 60)}`)),
    ...(errors.length > 20 ? [el("li", "muted", `…and ${errors.length - 20} more`)] : []),
  );
  $<HTMLButtonElement>("bulkAddBtn").disabled = proxies.length === 0;
  $("bulkAddText").textContent = proxies.length ? `Add ${proxies.length} prox${proxies.length === 1 ? "y" : "ies"}` : "Add proxies";
}

async function addBulk(): Promise<void> {
  if (!bulkParsed?.proxies.length) return;
  const start = Number(val("bulkStart") || 0);
  const end = Number(val("bulkEnd") || 0);
  if (end < start) {
    showPageError("Session 'to' must be at least 'from'");
    return;
  }
  const names = bulkNames(bulkParsed.proxies, val("bulkNameBy") as NameBy);
  const country = val("bulkCountry").toLowerCase();
  const city = val("bulkCity").toLowerCase();
  const list: ProxyProfile[] = bulkParsed.proxies.map((p, i) => ({
    id: crypto.randomUUID(),
    name: names[i] ?? "",
    scheme: p.scheme,
    host: p.host,
    port: p.port,
    usernameTemplate: p.username,
    password: p.password,
    country,
    city,
    sessionStart: start,
    sessionEnd: end,
  }));
  // Templates with tokens need values; catch that here, not at connect time.
  for (const p of list) {
    if (templateTokens(p.usernameTemplate).length) {
      try {
        renderUsername(p.usernameTemplate, { session: start, country, city });
      } catch (err) {
        showPageError(`${displayName(p)}: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }
  }
  $<HTMLButtonElement>("bulkAddBtn").disabled = true;
  $("bulkSpin").hidden = false;
  $("bulkAddText").textContent = `Adding ${list.length}…`;
  const ok = await run({ type: "bulkAdd", profiles: list });
  $("bulkSpin").hidden = true;
  if (ok) {
    setVal("bulkText", "");
    $("bulk").hidden = true;
    if (confirm(`Added ${list.length} proxies. Test them now to get their scores?`)) {
      void startTest(list.map((p) => p.id));
    }
  } else {
    previewBulk();
  }
}

// ---------- events ----------

$("search").addEventListener("input", renderList);
$("sort").addEventListener("change", renderList);
$("newBtn").addEventListener("click", () => openEditor());
$("bulkBtn").addEventListener("click", openBulk);
$("bulkCancel").addEventListener("click", () => ($("bulk").hidden = true));
$("bulkText").addEventListener("input", previewBulk);
$("bulkScheme").addEventListener("change", previewBulk);
$("bulkAddBtn").addEventListener("click", () => void addBulk());
$("testAllBtn").addEventListener("click", () => void startTest());
$("testCancel").addEventListener("click", () => void run({ type: "cancelTests" }).then(syncTestRun));
$("logFilter").addEventListener("change", () => void renderLogs());
$("cancelBtn").addEventListener("click", () => ($("editor").hidden = true));
$("scheme").addEventListener("change", updateSocksWarning);
$("pass").addEventListener("input", updateSocksWarning);

$("pasteBtn").addEventListener("click", () => {
  try {
    const p = parseProxyLine(val("paste"), val("scheme") as Scheme);
    setVal("scheme", p.scheme);
    setVal("host", p.host);
    setVal("port", p.port);
    setVal("user", p.username);
    setVal("pass", p.password);
    $("formError").hidden = true;
    updateSocksWarning();
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
  }
});

$<HTMLFormElement>("form").addEventListener("submit", (e) => {
  e.preventDefault();
  let profile: ProxyProfile;
  try {
    profile = readForm();
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
    return;
  }
  setSaving(true);
  void run({ type: "saveProfile", profile }).then((ok) => {
    setSaving(false);
    if (ok) $("editor").hidden = true;
  });
});

$("deleteBtn").addEventListener("click", () => {
  if (!editingId) return;
  const p = profiles.find((x) => x.id === editingId);
  if (!confirm(`Delete ${p ? displayName(p) : "this proxy"}?`)) return;
  void run({ type: "deleteProfile", id: editingId }).then(() => ($("editor").hidden = true));
});

$<HTMLInputElement>("fabToggle").addEventListener("change", (e) => {
  const on = (e.target as HTMLInputElement).checked;
  void run({ type: "setSettings", settings: { floatingButton: on } });
});

let lastCheck = "";
$("checkBtn").addEventListener("click", async () => {
  $<HTMLButtonElement>("checkBtn").disabled = true;
  $("checkSpin").hidden = false;
  $("checkText").textContent = "Checking…";
  const reply = await send({ type: "browserCheck" });
  $<HTMLButtonElement>("checkBtn").disabled = false;
  $("checkSpin").hidden = true;
  $("checkText").textContent = "Run again";
  const steps = reply.ok ? (reply.check ?? []) : [{ name: "Background", ok: false, ms: 0, detail: reply.error }];
  $("checkList").replaceChildren(
    ...steps.map((s) => {
      const li = el("li");
      li.append(
        el("span", s.ok ? "ok" : "bad", s.ok ? "✓" : "✕"),
        el("strong", "mono", s.name),
        el("span", "detail muted", s.detail),
        el("span", "ms muted mono", s.ms ? formatDuration(s.ms) : ""),
      );
      return li;
    }),
  );
  lastCheck = steps.map((s) => `${s.ok ? "OK  " : "FAIL"} ${s.name}: ${s.detail}${s.ms ? ` (${formatDuration(s.ms)})` : ""}`).join("\n");
  $("checkResult").hidden = false;
});
$("copyCheck").addEventListener("click", () => {
  void navigator.clipboard.writeText(lastCheck).then(() => ($("copyCheck").textContent = "Copied"));
});

$("clearLogs").addEventListener("click", () => {
  if (confirm("Clear all activity? Scores are kept.")) void run({ type: "clearLogs" });
});

// Live updates: logs, scores and test progress change while the page is open.
let statsTimer: number | undefined;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.logs) void renderLogs();
  if (area === "local" && changes.stats) {
    // Test all writes often; redraw at most a few times a second.
    clearTimeout(statsTimer);
    statsTimer = window.setTimeout(() => {
      stats = (changes.stats!.newValue as Record<string, ProxyStats> | undefined) ?? {};
      renderList();
      void renderLogs();
    }, 250);
  }
  if ((area === "local" && (changes.enabled || changes.activeProfileId)) || (area === "session" && changes.status)) {
    void run({ type: "getState" });
  }
  if (area === "session" && changes.testRun) renderTestRun((changes.testRun.newValue as TestRun | null) ?? null);
});
// Keep the elapsed time on the progress line ticking.
setInterval(() => {
  if (testing) void syncTestRun();
}, 1000);

void run({ type: "listProfiles" }).then(syncTestRun);
