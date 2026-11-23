import type { ProxyProfile, RuntimeState } from "../core/types";
import { formatAgo, formatDuration } from "../core/format";
import { displayName } from "../core/profile";
import { renderUsername, usesSession } from "../core/username";
import { send, type Message } from "../shared/messages";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const toggle = $<HTMLInputElement>("toggle");
const fabToggle = $<HTMLInputElement>("fabToggle");
const select = $<HTMLSelectElement>("profile");
const errorEl = $("error");
const search = $<HTMLInputElement>("search");
const SEARCH_MIN = 5; // search shows only when there are more proxies than this
let lastProfiles: ProxyProfile[] = [];
let lastState: RuntimeState | null = null;
let lastScores: Record<string, number | null> = {};
let unsupported = false;

const LABELS: Record<RuntimeState["status"], string> = {
  off: "Off",
  connecting: "Connecting…",
  connected: "Connected",
  auth_failed: "Login failed",
  error: "Error",
  conflict: "Blocked by another extension",
};

const BUSY_TEXT: Partial<Record<Message["type"], string>> = {
  setEnabled: "Working…",
  setActive: "Switching…",
  checkIp: "Checking IP…",
  newSession: "Getting a new session…",
};

async function run(msg: Message): Promise<void> {
  setBusy(true, BUSY_TEXT[msg.type]);
  try {
    const reply = await send(msg);
    if (!reply.ok) throw new Error(reply.error);
    errorEl.hidden = true;
    fabToggle.checked = reply.settings.floatingButton;
    lastScores = reply.scores;
    unsupported = !reply.support.canProxy;
    $("unsupported").hidden = !unsupported;
    $("unsupportedText").textContent = !unsupported
      ? ""
      : reply.support.unresponsive
        ? "This browser's proxy setting for extensions doesn't respond (this happens in Orion on iPhone/iPad), so RelaySwitch can't switch proxies here."
        : `This browser can't run RelaySwitch: it has no ${reply.support.missing.join(" or ") || "proxy support"}. Use Chrome, Edge, Brave, Opera or Arc.`;
    $("deviceHelp").hidden = !(unsupported && reply.profiles.length > 0);
    render(reply.state, reply.profiles);
  } catch (err) {
    errorEl.textContent = err instanceof Error ? err.message : String(err);
    errorEl.hidden = false;
    const fresh = await send({ type: "getState" });
    if (fresh.ok) render(fresh.state, fresh.profiles);
  } finally {
    setBusy(false);
    // Nothing to switch on in a browser without proxy support.
    toggle.disabled = unsupported;
    for (const id of ["check", "newSession"]) $<HTMLButtonElement>(id).disabled = unsupported;
  }
}

function setBusy(busy: boolean, text?: string): void {
  $("spinner").hidden = !busy;
  if (busy && text) $("statusText").textContent = text;
  for (const el of document.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>("button, input, select")) {
    el.disabled = busy;
  }
}

function render(state: RuntimeState, profiles: ProxyProfile[]): void {
  lastProfiles = profiles;
  lastState = state;
  $("empty").hidden = profiles.length > 0;
  $("main").hidden = profiles.length === 0;
  toggle.checked = state.enabled;

  search.hidden = profiles.length <= SEARCH_MIN;
  if (search.hidden) search.value = "";
  const q = search.value.trim().toLowerCase();
  // The active proxy always stays in the list so the select shows it.
  const shown = profiles.filter(
    (p) => !q || p.id === state.activeProfileId || displayName(p).toLowerCase().includes(q),
  );
  $("noMatch").hidden = !q || shown.some((p) => p.id !== state.activeProfileId);
  select.size = q ? Math.min(Math.max(shown.length, 2), 6) : 0;
  select.replaceChildren(
    ...shown.map((p) => {
      const opt = document.createElement("option");
      opt.value = p.id;
      const score = lastScores[p.id];
      opt.textContent = score === null || score === undefined ? displayName(p) : `${displayName(p)}  ·  ${score}/100`;
      opt.selected = p.id === state.activeProfileId;
      return opt;
    }),
  );

  const active = profiles.find((p) => p.id === state.activeProfileId);
  $("statusText").textContent =
    state.enabled && active && (state.status === "connected" || state.status === "connecting")
      ? `${LABELS[state.status]} · ${displayName(active)}`
      : LABELS[state.status];
  $("ipLine").textContent = state.exitIp
    ? `Exit IP ${state.exitIp}${state.latencyMs !== null ? ` · ${formatDuration(state.latencyMs)}` : ""}`
    : "";
  const session = state.sessionId !== null ? `Session ${state.sessionId}` : "";
  const checked = state.exitIp && state.checkedAt ? `checked ${formatAgo(state.checkedAt)}` : "";
  $("detail").textContent = [state.statusDetail, session, checked].filter(Boolean).join(" · ");

  const dot = $("dot");
  dot.className = "dot";
  if (state.status === "connected") dot.classList.add("ok");
  else if (state.status === "connecting") dot.classList.add("warn");
  else if (state.status !== "off") dot.classList.add("bad");

  $("check").hidden = !state.enabled;
  $("newSession").hidden = !(state.enabled && active && usesSession(active.usernameTemplate));
}

search.addEventListener("input", () => {
  if (lastState) render(lastState, lastProfiles);
});
search.addEventListener("keydown", (e) => {
  // Enter switches to the first match.
  if (e.key !== "Enter") return;
  const first = [...select.options].find((o) => o.value !== lastState?.activeProfileId) ?? select.options[0];
  if (first && first.value !== lastState?.activeProfileId) {
    search.value = "";
    void run({ type: "setActive", id: first.value });
  }
});

/** Server, port and login of the selected proxy, for the device's own proxy settings. */
function proxyDetails(): string {
  const p = lastProfiles.find((x) => x.id === lastState?.activeProfileId) ?? lastProfiles[0];
  if (!p) return "";
  let username = p.usernameTemplate;
  try {
    username = renderUsername(p.usernameTemplate, {
      session: usesSession(p.usernameTemplate) ? (lastState?.sessionId ?? p.sessionStart) : null,
      country: p.country,
      city: p.city,
    });
  } catch {
    // keep the template as typed
  }
  return [`Server: ${p.host}`, `Port: ${p.port}`, username ? `Username: ${username}` : "", p.password ? `Password: ${p.password}` : ""]
    .filter(Boolean)
    .join("\n");
}

$("copyDetails").addEventListener("click", () => {
  void navigator.clipboard.writeText(proxyDetails()).then(
    () => ($("copyDetails").textContent = "Copied: server, port, username, password"),
    () => ($("copyDetails").textContent = "Couldn't copy. See Options for the details."),
  );
});

fabToggle.addEventListener("change", () =>
  void run({ type: "setSettings", settings: { floatingButton: fabToggle.checked } }),
);

toggle.addEventListener("change", () => void run({ type: "setEnabled", enabled: toggle.checked }));
select.addEventListener("change", () => void run({ type: "setActive", id: select.value }));
$("check").addEventListener("click", () => void run({ type: "checkIp" }));
$("newSession").addEventListener("click", () => void run({ type: "newSession" }));
for (const id of ["options", "addFirst"]) {
  $(id).addEventListener("click", (e) => {
    e.preventDefault();
    void chrome.runtime.openOptionsPage();
  });
}

void run({ type: "getState" }).then(() => {
  if (!search.hidden) search.focus();
});
