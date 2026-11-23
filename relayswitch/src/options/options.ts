import { formatAgo, formatDuration } from "../core/format";
import { displayName } from "../core/profile";
import { scoreBand, scoreOf, type Score } from "../core/score";
import type { LogEntry, ProxyProfile, ProxyStats } from "../core/types";
import { send, type AuthInfo, type LegacyInfo, type Message, type Reply } from "../shared/messages";
import { renderAccount, renderSignIn } from "../shared/signin";
import type { TestRun } from "../shared/storage";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const val = (id: string) => $<HTMLInputElement>(id).value.trim();
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
/** Web panel page where proxies are added, edited and deleted. */
let panelUrl = "";
let testing = false;
let signedIn = false;
let lastReply: Extract<Reply, { ok: true }> | null = null;

// ---------- sign-in ----------

function renderAuth(auth: AuthInfo, legacy: LegacyInfo | null): void {
  const changed = signedIn !== auth.signedIn;
  signedIn = auth.signedIn;
  $("appContent").hidden = !signedIn;
  $("manageBtn").hidden = !signedIn;
  panelUrl = auth.apiBase.replace(/\/+$/, "") + "/app#proxies";
  $("account").hidden = !signedIn;
  $("signinCard").hidden = signedIn;
  $("serverError").hidden = !(signedIn && auth.error);
  $("serverError").textContent = signedIn ? (auth.error ?? "") : "";
  if (!signedIn) {
    $("migrate").hidden = true;
    // Don't wipe what the user is typing when the page refreshes itself.
    if (changed || !$("signinCard").childElementCount) {
      renderSignIn($("signinCard"), auth, () => void run({ type: "listProfiles" }));
    }
    return;
  }
  renderAccount($("account"), auth, () => void run({ type: "getState" }));
  renderMigrate(legacy);
}

function renderMigrate(legacy: LegacyInfo | null): void {
  $("migrate").hidden = !legacy;
  if (!legacy) return;
  const parts = [
    legacy.profiles ? `${legacy.profiles} prox${legacy.profiles === 1 ? "y" : "ies"}` : "",
    legacy.checks ? `${legacy.checks} test result${legacy.checks === 1 ? "" : "s"}` : "",
    legacy.logs ? `${legacy.logs} activity entr${legacy.logs === 1 ? "y" : "ies"}` : "",
  ].filter(Boolean);
  $("migrateText").textContent =
    `This browser still has ${parts.join(", ")} saved by an older RelaySwitch version. ` +
    "Proxies are now kept in your account and added in the web panel. To keep these ones:";
  $("migrateCopy").hidden = !legacy.profiles;
}

/** Opens the web panel (proxies are added, edited and deleted there). */
function openPanel(): void {
  if (panelUrl) void chrome.tabs.create({ url: panelUrl });
}

$("manageBtn").addEventListener("click", openPanel);
$("migrateOpen").addEventListener("click", openPanel);
$("migrateCopy").addEventListener("click", () => {
  void send({ type: "legacyExport" }).then(async (reply) => {
    if (!reply?.ok || !reply.legacyText) return showPageError("Nothing to copy.");
    await navigator.clipboard.writeText(reply.legacyText);
    const n = reply.legacyText.split("\n").length;
    $("migrateCopy").textContent = `Copied ${n} prox${n === 1 ? "y" : "ies"} ✓`;
  });
});
$("migrateDrop").addEventListener("click", () => {
  if (!confirm("Remove the old proxies, test results and activity from this browser? Do this after adding the proxies in the web panel.")) return;
  void run({ type: "dropLegacy" });
});

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
    showPageError(reply.error);
    return false;
  }
  $("pageError").hidden = true;
  lastReply = reply;
  renderAuth(reply.auth, reply.legacy);
  if (!reply.auth.signedIn) {
    $("loadingList").hidden = true;
    profiles = [];
    stats = {};
    return true;
  }
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
  // Scores come from the server; the worker caches them in session storage.
  const data = (await chrome.storage.session.get("stats")) as { stats?: Record<string, ProxyStats> };
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
  li.dataset.testid = "proxy-row";
  li.dataset.proxyId = p.id;
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
  actions.append(test, logs);

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
  if (!signedIn) return;
  const { logs = [] } = (await chrome.storage.session.get("logs")) as { logs?: LogEntry[] };
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

// ---------- events ----------

$("search").addEventListener("input", renderList);
$("sort").addEventListener("change", renderList);
$("testAllBtn").addEventListener("click", () => void startTest());
$("testCancel").addEventListener("click", () => void run({ type: "cancelTests" }).then(syncTestRun));
$("logFilter").addEventListener("change", () => void renderLogs());

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
  if (area === "session" && changes.logs) void renderLogs();
  if (area === "session" && changes.stats) {
    // Test all writes often; redraw at most a few times a second.
    clearTimeout(statsTimer);
    statsTimer = window.setTimeout(() => {
      stats = (changes.stats!.newValue as Record<string, ProxyStats> | undefined) ?? {};
      renderList();
      void renderLogs();
    }, 250);
  }
  if (
    (area === "local" && (changes.enabled || changes.activeProfileId || changes.refreshToken)) ||
    (area === "session" && (changes.status || changes.profiles || changes.authError))
  ) {
    void run({ type: "getState" });
  }
  if (area === "session" && changes.testRun) renderTestRun((changes.testRun.newValue as TestRun | null) ?? null);
});
// Keep the elapsed time on the progress line ticking.
setInterval(() => {
  if (testing) void syncTestRun();
}, 1000);

void run({ type: "listProfiles" }).then(syncTestRun);
