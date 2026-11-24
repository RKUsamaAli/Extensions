import { displayName } from "../core/profile";
import { formatDuration } from "../core/format";
import { testIdFromUrl } from "../core/pac";
import { scoreOf, byBestScore } from "../core/score";
import type { ProxyProfile } from "../core/types";
import { nextSession, renderUsername, usesSession } from "../core/username";
import { MAX_AUTH_FAILURES } from "../shared/config";
import type { LegacyInfo, MenuReply, Message, PageMessage, Reply, Settings, SupportInfo } from "../shared/messages";
import {
  activeProfile,
  getLocal,
  getSession,
  log,
  profiles as cachedProfiles,
  recordResult,
  runtimeState,
  setLocal,
  setSession,
  who,
} from "../shared/storage";
import { HubError } from "../shared/hub";
import {
  authInfo,
  bootstrap,
  clearLogsRemote,
  isSignedIn,
  dropLegacy,
  legacyInfo,
  legacyProxyLines,
  loadAll,
  login,
  logout,
  onSignedOut,
  requireSignedIn,
  scheduleFlush,
  signOutLocal,
} from "./sync";
import { cancelTests, runTests } from "./tester";
import { checkExitIp } from "./ipcheck";
import { syncFloatingButton } from "./fab";
import { applyProxy, clearProxy, controlProblem, forgetProxyLogin } from "./proxy";
import { runBrowserCheck, type CheckStep } from "./diagnose";
import { detectSupport, safeListen } from "./support";

// ---- Listeners: all registered synchronously at top level (MV3 rule). ----
// Messaging first, so the popup and options page always get an answer, even
// in a browser that lacks some of the APIs below.

const support = detectSupport();
const failedListeners: string[] = [];
const missingListener = (name: string) => failedListeners.push(name);

chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  // Content scripts always run in a tab with a web page URL. Our own pages
  // (popup, options, even when options is open in a tab) have our extension
  // URL; some browsers leave url empty for the popup, so no tab counts too.
  // The on-page button gets the restricted handler: names and status only.
  const fromOwnPage = (sender.url ?? "").startsWith(chrome.runtime.getURL("")) || !sender.tab;
  const work = fromOwnPage ? handle(msg as Message) : handlePage(msg as PageMessage);
  work
    .then(sendResponse)
    .catch((err: unknown) => sendResponse({ ok: false, error: errorText(err) }));
  return true; // async response
});

safeListen("webRequest.onAuthRequired", () =>
  chrome.webRequest.onAuthRequired.addListener(
    (details, callback) => {
      void answerAuth(details).then((resp) => callback?.(resp));
    },
    { urls: ["<all_urls>"] },
    ["asyncBlocking"],
  ), missingListener);

safeListen("webRequest.onErrorOccurred", () =>
  chrome.webRequest.onErrorOccurred.addListener(
    (details) => void onRequestError(details),
    { urls: ["<all_urls>"], types: ["main_frame"] },
  ), missingListener);

safeListen("webRequest.onCompleted", () =>
  chrome.webRequest.onCompleted.addListener(
    () => void resetAuthFailures(),
    { urls: ["<all_urls>"], types: ["main_frame"] },
  ), missingListener);

// The server ended the sign-in: nothing may keep using its proxies.
onSignedOut(async (reason) => {
  const profile = await activeProfile();
  await turnOff("off", reason).catch(() => {});
  if (profile) await forgetProxyLogin(profile).catch(() => {});
});

// The worker restarts often; send anything that was still waiting.
scheduleFlush(1_000);

safeListen("runtime.onStartup", () => chrome.runtime.onStartup.addListener(() => void restore()), missingListener);
safeListen("runtime.onInstalled", () => chrome.runtime.onInstalled.addListener(() => void restore()), missingListener);

const UNRESPONSIVE_MSG =
  "This browser has a proxy setting for extensions, but it doesn't respond, so RelaySwitch can't change the proxy here. " +
  "This happens in Orion on iPhone and iPad. Set the proxy in the device settings instead (Copy proxy details in the popup), " +
  "or use RelaySwitch in Chrome, Edge, Brave, Opera or Arc on a computer.";

/** True when an error means proxy.settings exists but never answered. */
const isUnresponsive = (err: unknown) => /didn't answer proxy\.settings/.test(errorText(err));

async function markUnresponsive(): Promise<never> {
  await setSession({ proxyUnresponsive: true, status: "error", statusDetail: "Proxy setting doesn't respond" });
  await log({ level: "error", event: "proxy_unresponsive", detail: "proxy.settings did not answer" });
  await updateBadge();
  throw new Error(UNRESPONSIVE_MSG);
}

/** Thrown when the browser can't do proxies at all. */
async function assertCanProxy(): Promise<void> {
  if ((await getSession()).proxyUnresponsive) throw new Error(UNRESPONSIVE_MSG);
  if (support.canProxy && !failedListeners.includes("webRequest.onAuthRequired")) return;
  throw new Error(
    `This browser doesn't support what RelaySwitch needs: ${support.missing.join(", ") || "proxy login events"}. ` +
      "Use Chrome, Edge, Brave, Opera or Arc.",
  );
}

// ---- Auth ----

async function answerAuth(
  details: chrome.webRequest.WebAuthenticationChallengeDetails,
): Promise<chrome.webRequest.BlockingResponse> {
  // Never give proxy credentials to a website's own login prompt.
  if (!details.isProxy) return {};

  // A Test all request: answer with the login of the proxy under test.
  const testId = testIdFromUrl(details.url);
  if (testId) return answerTestAuth(testId);

  const { enabled } = await getLocal();
  const profile = await activeProfile();
  if (!enabled || !profile) return { cancel: true };
  if (details.challenger.host.toLowerCase() !== profile.host.toLowerCase()) return {};

  const session = await getSession();
  const failures = session.authFailures + 1;
  await setSession({ authFailures: failures });
  if (failures > MAX_AUTH_FAILURES) {
    await log({ level: "error", event: "auth_fail", ...who(profile) });
    await recordResult(profile.id, { t: Date.now(), ok: false, error: "Login failed", source: "use" });
    await turnOff("auth_failed", "Wrong username or password");
    return { cancel: true };
  }
  try {
    const username = renderUsername(profile.usernameTemplate, {
      session: session.sessionId,
      country: profile.country,
      city: profile.city,
    });
    if (failures === 1) {
      await log({ level: "info", event: "auth_sent", ...who(profile), detail: `user ${username}` });
    }
    return { authCredentials: { username, password: profile.password } };
  } catch (err) {
    await turnOff("error", errorText(err));
    return { cancel: true };
  }
}

async function answerTestAuth(id: string): Promise<chrome.webRequest.BlockingResponse> {
  const profiles = await cachedProfiles();
  const p = profiles.find((x) => x.id === id);
  const { testAuthTries } = await getSession();
  await setSession({ testAuthTries: testAuthTries + 1 });
  // A second challenge means the login was refused: give up, the test records it.
  if (!p || testAuthTries >= 1) return { cancel: true };
  try {
    const username = renderUsername(p.usernameTemplate, {
      session: usesSession(p.usernameTemplate) ? p.sessionStart : null,
      country: p.country,
      city: p.city,
    });
    return { authCredentials: { username, password: p.password } };
  } catch {
    return { cancel: true };
  }
}

async function resetAuthFailures(): Promise<void> {
  const { authFailures } = await getSession();
  if (authFailures !== 0) await setSession({ authFailures: 0 });
}

// ---- Errors ----

const PROXY_ERRORS = new Set([
  "net::ERR_PROXY_CONNECTION_FAILED",
  "net::ERR_TUNNEL_CONNECTION_FAILED",
  "net::ERR_PROXY_AUTH_UNSUPPORTED",
  "net::ERR_SOCKS_CONNECTION_FAILED",
  "net::ERR_PROXY_CERTIFICATE_INVALID",
]);

const lastUseError = new Map<string, number>();

async function onRequestError(details: chrome.webRequest.WebResponseErrorDetails): Promise<void> {
  if (!PROXY_ERRORS.has(details.error)) return;
  const { enabled } = await getLocal();
  if (!enabled) return;
  const profile = await activeProfile();
  await setSession({ status: "error", statusDetail: details.error.replace("net::", "") });
  if (profile && Date.now() - (lastUseError.get(profile.id) ?? 0) > 30_000) {
    lastUseError.set(profile.id, Date.now());
    await recordResult(profile.id, { t: Date.now(), ok: false, error: details.error.replace("net::", ""), source: "use" });
  }
  await log({ level: "warn", event: "proxy_error", ...who(profile), detail: details.error });
  await updateBadge();
}

// ---- On / off ----

async function turnOn(): Promise<void> {
  await requireSignedIn();
  await assertCanProxy();
  const profile = await activeProfile();
  if (!profile) throw new Error("Add a proxy in Options first");

  let problem: string | null;
  try {
    problem = await controlProblem();
  } catch (err) {
    if (isUnresponsive(err)) return markUnresponsive();
    throw err;
  }
  if (problem) {
    await setSession({ status: "conflict", statusDetail: problem });
    await log({ level: "warn", event: "conflict", detail: problem });
    await updateBadge();
    return;
  }

  await prepareSession(profile);
  await setLocal({ enabled: true, activeProfileId: profile.id });
  await setSession({ status: "connecting", statusDetail: "", authFailures: 0 });
  await updateBadge();

  if (profile.scheme.startsWith("socks") && profile.password) {
    await log({
      level: "warn",
      event: "socks_auth",
      ...who(profile),
      detail: "Chrome can't send a SOCKS username/password; use HTTP or IP allow-listing",
    });
  }

  await applyProxy(profile);
  await log({ level: "info", event: "connect", ...who(profile) });
  await runIpCheck();
}

async function turnOff(status: "off" | "auth_failed" | "error" = "off", detail = ""): Promise<void> {
  if (!(await getSession()).proxyUnresponsive) {
    await clearProxy().catch(async (err: unknown) => {
      if (!isUnresponsive(err)) throw err;
      await setSession({ proxyUnresponsive: true });
    });
  }
  await setLocal({ enabled: false });
  await setSession({ status, statusDetail: detail, exitIp: null, latencyMs: null, checkedAt: null });
  await log({ level: status === "off" ? "info" : "error", event: "disconnect", detail });
  await updateBadge();
}

async function prepareSession(profile: ProxyProfile): Promise<void> {
  if (!usesSession(profile.usernameTemplate)) {
    await setSession({ sessionId: null });
    return;
  }
  const { sessionId } = await getSession();
  if (sessionId === null || sessionId < profile.sessionStart || sessionId > profile.sessionEnd) {
    await setSession({ sessionId: profile.sessionStart });
  }
}

async function newSession(): Promise<void> {
  const profile = await activeProfile();
  if (!profile || !usesSession(profile.usernameTemplate)) {
    throw new Error("This proxy has no {session} in its username");
  }
  const { sessionId, exitIp } = await getSession();
  const next = nextSession(sessionId, profile.sessionStart, profile.sessionEnd);
  await setSession({ sessionId: next, authFailures: 0, status: "connecting" });
  await applyProxy(profile);
  await log({ level: "info", event: "new_session", ...who(profile), detail: `session ${next}` });
  await runIpCheck();
  const after = await getSession();
  if (exitIp && after.exitIp === exitIp) {
    await log({ level: "warn", event: "ip_unchanged", ...who(profile), detail: exitIp });
    await setSession({ statusDetail: "New session, same IP" });
  }
}

async function runIpCheck(): Promise<void> {
  const { enabled } = await getLocal();
  if (!enabled) return;
  try {
    const { ip, latencyMs } = await checkExitIp();
    await setSession({
      status: "connected",
      statusDetail: "",
      exitIp: ip,
      latencyMs,
      checkedAt: Date.now(),
      authFailures: 0,
    });
    const p = await activeProfile();
    await log({ level: "info", event: "ip_check", ...who(p), detail: `${ip} · ${formatDuration(latencyMs)}` });
    if (p) await recordResult(p.id, { t: Date.now(), ok: true, ms: latencyMs, ip, source: "use" });
  } catch (err) {
    const { status } = await getSession();
    // turnOff may already have set auth_failed during the check.
    if (status !== "auth_failed") {
      await setSession({ status: "error", statusDetail: errorText(err) });
    }
    const p = await activeProfile();
    await log({ level: "warn", event: "ip_check_failed", ...who(p), detail: errorText(err) });
    if (p) await recordResult(p.id, { t: Date.now(), ok: false, error: errorText(err), source: "use" });
  }
  await updateBadge();
}

/** Browser start: check the sign-in and load the user's proxies. There is no
 * offline mode: if the server can't be reached, nothing is loaded and the
 * proxy stays off. */
async function connectServer(): Promise<boolean> {
  if (!(await isSignedIn())) return false;
  try {
    await bootstrap();
    await loadAll(true);
    return true;
  } catch (err) {
    if (!(err instanceof HubError && err.signsOut)) {
      await setSession({ profiles: [], stats: {}, logs: [], loadedAt: null, authError: errorText(err) });
    }
    return false;
  }
}

/** Proxy cleared while the server is unreachable; `enabled` stays on so it reconnects later. */
async function waitForServer(detail: string): Promise<void> {
  await clearProxy().catch(() => {});
  await setSession({ status: "error", statusDetail: `${detail} – retrying`, exitIp: null, latencyMs: null, checkedAt: null });
  await updateBadge();
}

let ensuring: Promise<void> | null = null;
/**
 * Keeps every tab working without opening the popup: loads the proxies when they are
 * missing or stale (browser restart, failed start, changes made in the web panel),
 * reconnects a proxy that is meant to be on, and disconnects one that was switched off
 * or deleted in the panel. Runs at start, every minute and on each page menu request.
 */
function ensureReady(): Promise<void> {
  ensuring ??= (async () => {
    if (!support.canProxy || !(await isSignedIn())) return;
    const before = await getSession();
    await loadAll(false).catch(() => {});
    const { enabled, activeProfileId } = await getLocal();
    if (!enabled) return;
    const s = await getSession();
    if (s.loadedAt === null) return waitForServer(s.authError ?? "Can't reach the server");
    const list = await cachedProfiles();
    if (activeProfileId && !list.some((p) => p.id === activeProfileId)) {
      return turnOff("error", "This proxy was switched off or deleted in the web panel. Pick another one.");
    }
    const waiting = s.status === "error" && /retrying$/.test(s.statusDetail ?? "");
    if (s.status === "off" || waiting || (before.loadedAt === null && s.status !== "connected" && s.status !== "connecting")) {
      await turnOn().catch((err: unknown) => turnOff("error", errorText(err)));
    }
  })().finally(() => {
    ensuring = null;
  });
  return ensuring;
}

const SYNC_ALARM = "relayswitch-sync";
safeListen("alarms", () => {
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener((a) => {
    if (a.name === SYNC_ALARM) void ensureReady();
  });
}, missingListener);

async function restore(): Promise<void> {
  if (!support.canProxy) {
    await setSession({ status: "error", statusDetail: "Browser not supported" }).catch(() => {});
    return;
  }
  const { enabled, floatingButton } = await getLocal();
  await syncFloatingButton(floatingButton).catch((err: unknown) =>
    log({ level: "warn", event: "fab_sync_failed", detail: errorText(err) }),
  );
  const online = await connectServer();
  if (enabled && !online) {
    // No server, no proxy – but remember it was on: ensureReady() reconnects when the
    // server answers again (every minute, and whenever a page asks).
    if (await isSignedIn()) await waitForServer((await getSession()).authError ?? "Can't reach the server");
    else await turnOff("error", (await getSession()).authError ?? "Sign in to RelaySwitch").catch(() => {});
    return;
  }
  if (enabled) {
    await turnOn().catch((err: unknown) => turnOff("error", errorText(err)));
  } else {
    await updateBadge();
  }
}

// ---- Profiles ----

async function setActive(id: string): Promise<void> {
  const { enabled } = await getLocal();
  const profiles = await cachedProfiles();
  if (!profiles.some((p) => p.id === id)) throw new Error("Profile not found");
  await setLocal({ activeProfileId: id });
  await setSession({ sessionId: null });
  if (enabled) await turnOn();
}

// ---- Messages ----

/** Messages that change the live proxy; blocked while a test run owns it. */
const CHANGES_PROXY = new Set(["setEnabled", "setActive", "newSession", "saveProfile", "menuConnect", "menuOff"]);

async function assertNotTesting(type: string): Promise<void> {
  if (!CHANGES_PROXY.has(type)) return;
  const { testRun } = await getSession();
  if (testRun?.running) throw new Error("Proxy test in progress. Wait for it or cancel it first.");
}

async function scores(): Promise<Record<string, number | null>> {
  const { profiles, stats } = await getSession();
  return Object.fromEntries(profiles.map((p) => [p.id, scoreOf(stats[p.id]?.results ?? []).value]));
}

/** Messages that work while signed out. */
const SIGNED_OUT_OK = new Set(["getState", "listProfiles", "getAuth", "login", "logout", "browserCheck", "setSettings"]);

async function handle(msg: Message): Promise<Reply> {
  await assertNotTesting(msg.type);
  if (!SIGNED_OUT_OK.has(msg.type)) await requireSignedIn();
  let legacyText: string | undefined;
  let check: CheckStep[] | undefined;
  switch (msg.type) {
    case "getAuth":
      break;
    case "getState":
    case "listProfiles":
      // Pages get fresh data from the server; a short cache avoids reloading on every click.
      if (await isSignedIn()) {
        if (msg.type === "getState" && msg.cached && (await getSession()).loadedAt !== null) break;
        await loadAll(msg.type === "listProfiles").catch(async (err: unknown) => {
          if (!(err instanceof HubError && err.signsOut)) await setSession({ authError: errorText(err) });
        });
      }
      break;
    case "login":
      await login(msg.username, msg.password, msg.apiBase).catch(async (err: unknown) => {
        // Signed in but the follow-up checks failed (e.g. update required): don't stay half signed in.
        if (await isSignedIn()) await signOutLocal(errorText(err));
        throw err;
      });
      break;
    case "legacyExport":
      legacyText = await legacyProxyLines();
      break;
    case "dropLegacy":
      await dropLegacy();
      break;
    case "logout":
      await turnOff().catch(() => {});
      await logout();
      break;
    case "setEnabled":
      if (msg.enabled) await turnOn();
      else await turnOff();
      break;
    case "checkIp":
      await runIpCheck();
      break;
    case "newSession":
      await newSession();
      break;
    case "setActive":
      await setActive(msg.id);
      break;
    case "clearLogs":
      await clearLogsRemote();
      break;
    case "testProxies":
      await assertCanProxy();
      // Runs in the background; the options page follows progress in storage.
      void runTests(msg.ids).catch((err: unknown) => log({ level: "error", event: "test_error", detail: errorText(err) }));
      break;
    case "cancelTests":
      await cancelTests();
      break;
    case "browserCheck":
      check = await runBrowserCheck(failedListeners);
      break;
    case "setSettings":
      if (msg.settings.floatingButton && !chrome.scripting?.registerContentScripts) {
        throw new Error("This browser doesn't support the floating button (scripting API).");
      }
      if (typeof msg.settings.floatingButton === "boolean") {
        await syncFloatingButton(msg.settings.floatingButton);
        await setLocal({ floatingButton: msg.settings.floatingButton });
      }
      break;
  }
  const { floatingButton } = await getLocal();
  const settings: Settings = { floatingButton };
  const auth = await authInfo();
  return {
    ok: true,
    state: await runtimeState(),
    profiles: auth.signedIn ? await cachedProfiles() : [],
    settings,
    scores: auth.signedIn ? await scores() : {},
    check,
    support: await supportReply(),
    auth,
    legacy: await legacyInfo().catch(() => null),
    legacyText,
  };
}

async function supportReply(): Promise<SupportInfo> {
  const { proxyUnresponsive } = await getSession();
  const canProxy = support.canProxy && !failedListeners.includes("webRequest.onAuthRequired") && !proxyUnresponsive;
  const missing = proxyUnresponsive ? ["a working proxy setting (proxy.settings doesn't respond)"] : support.missing;
  return { canProxy, missing, limited: support.limited, unresponsive: proxyUnresponsive };
}

async function handlePage(msg: PageMessage): Promise<MenuReply> {
  await assertNotTesting(msg?.type ?? "");
  const signedIn = await isSignedIn();
  if (!signedIn && msg?.type !== "menu" && msg?.type !== "menuMove" && msg?.type !== "menuSignIn") {
    throw new Error("Sign in to RelaySwitch first.");
  }
  switch (msg?.type) {
    case "menu":
      // Any tab asking for the menu gets loaded proxies and an applied proxy, popup or not.
      if (signedIn) await ensureReady();
      break;
    case "menuSignIn":
      await chrome.runtime.openOptionsPage();
      break;
    case "menuConnect": {
      const profiles = await cachedProfiles();
      if (!profiles.some((p) => p.id === msg.id)) throw new Error("Proxy not found");
      await setLocal({ activeProfileId: msg.id });
      await setSession({ sessionId: null });
      await turnOn();
      break;
    }
    case "menuOff":
      await turnOff();
      break;
    case "menuMove": {
      const side = msg.pos?.side === "left" ? "left" : "right";
      const top = Math.min(95, Math.max(5, Number(msg.pos?.top) || 70));
      await setLocal({ fabPos: { side, top } });
      break;
    }
    default:
      throw new Error("Not allowed");
  }
  const { enabled, fabPos } = await getLocal();
  const profiles = signedIn ? await cachedProfiles() : [];
  const state = await runtimeState();
  const scoreMap = signedIn ? await scores() : {};
  return {
    ok: true,
    menu: {
      signedIn,
      enabled,
      activeId: state.activeProfileId,
      status: state.status,
      exitIp: state.exitIp,
      items: [...profiles].sort(byBestScore<ProxyProfile>(scoreMap, displayName)).map((p) => ({ id: p.id, name: displayName(p), score: scoreMap[p.id] ?? null })),
      pos: fabPos,
    },
  };
}

// ---- Badge ----

async function updateBadge(): Promise<void> {
  const { enabled } = await getLocal();
  const { status } = await getSession();
  const profile = await activeProfile();
  const bad = status === "error" || status === "auth_failed" || status === "conflict";
  const text = bad ? "!" : enabled ? ((profile ? displayName(profile)[0]?.toUpperCase() : undefined) ?? "ON") : "";
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: bad ? "#C62828" : "#2E7D32" });
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
