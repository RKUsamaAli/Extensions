// Everything the worker does with the ext-hub server: sign-in, loading the
// user's proxies/scores/logs into session storage, saving changes, sending
// logs and checks in batches, and the one-time upload of old local data.
import {
  chunk,
  checksToStats,
  normalizeApiBase,
  profileBody,
  remapIds,
  remapLogs,
  statsToChecks,
  toProfile,
  type ServerProxy,
} from "../core/hubdata";
import type { CheckResult, LogEntry, ProxyProfile } from "../core/types";
import { FLUSH_MS, LOG_LIMIT, MAX_BATCH, MAX_BULK, STALE_MS } from "../shared/config";
import { Hub, HubError, type Bootstrap, type HubStore } from "../shared/hub";
import type { AuthInfo, LegacyInfo } from "../shared/messages";
import {
  clearServerData,
  deviceId,
  getLegacy,
  getLocal,
  getSession,
  onQueued,
  removeLegacy,
  requeue,
  serial,
  setLocal,
  setSession,
  takePending,
} from "../shared/storage";

const store: HubStore = {
  async load() {
    const local = await getLocal();
    const session = await getSession();
    return {
      apiBase: local.apiBase,
      deviceId: local.deviceId || (await deviceId()),
      refreshToken: local.refreshToken,
      accessToken: session.accessToken,
      accessExpiresAt: session.accessExpiresAt,
    };
  },
  async save(patch) {
    const local: Parameters<typeof setLocal>[0] = {};
    const session: Parameters<typeof setSession>[0] = {};
    if ("apiBase" in patch) local.apiBase = patch.apiBase!;
    if ("deviceId" in patch) local.deviceId = patch.deviceId!;
    if ("refreshToken" in patch) local.refreshToken = patch.refreshToken ?? null;
    if ("accessToken" in patch) session.accessToken = patch.accessToken ?? null;
    if ("accessExpiresAt" in patch) session.accessExpiresAt = patch.accessExpiresAt ?? null;
    if (Object.keys(local).length) await setLocal(local);
    if (Object.keys(session).length) await setSession(session);
  },
};

/** Runs when the server ends the sign-in: the worker turns the proxy off. */
let signedOutHandler: (reason: string) => Promise<void> = async () => {};
export function onSignedOut(fn: (reason: string) => Promise<void>): void {
  signedOutHandler = fn;
}

export const hub = new Hub({
  store,
  version: chrome.runtime.getManifest().version,
  onSignedOut: (err) => signOutLocal(err.message),
});

/** Clears tokens and every bit of server data, turns the proxy off, remembers why. */
export async function signOutLocal(reason: string | null): Promise<void> {
  await hub.clearTokens();
  await signedOutHandler(reason ?? "");
  await clearServerData();
  await setLocal({ activeProfileId: null });
  await setSession({ authError: reason });
}

export async function authInfo(): Promise<AuthInfo> {
  const { refreshToken, apiBase } = await getLocal();
  const { auth, authError } = await getSession();
  if (!refreshToken) return { signedIn: false, apiBase, error: authError ?? undefined };
  return {
    signedIn: true,
    apiBase,
    user: auth?.user,
    entitlement: auth?.entitlement ?? null,
    error: authError ?? undefined,
  };
}

export async function isSignedIn(): Promise<boolean> {
  return !!(await getLocal()).refreshToken;
}

export async function requireSignedIn(): Promise<void> {
  if (!(await isSignedIn())) throw new Error("Sign in to RelaySwitch first.");
}

/** Checks access and version with the server and caches the user. */
export async function bootstrap(): Promise<Bootstrap> {
  const b = await hub.get<Bootstrap>("/bootstrap?ext=relayswitch");
  await setSession({
    auth: { signedIn: true, apiBase: (await getLocal()).apiBase, user: b.user, entitlement: b.entitlement },
    authError: b.enabled === false ? "RelaySwitch is switched off by the admin right now." : null,
  });
  if (b.enabled === false) throw new HubError("ext_disabled", "RelaySwitch is switched off by the admin right now.", 503);
  return b;
}

export async function login(username: string, password: string, apiBase: string): Promise<void> {
  if (!username.trim() || !password) throw new Error("Enter your username and password.");
  await setSession({ authError: null });
  // A different account may sign in: never show the previous user's data.
  await clearServerData();
  await hub.login(username.trim(), password, normalizeApiBase(apiBase));
  await bootstrap();
  await loadAll(true);
}

export async function logout(): Promise<void> {
  await flush().catch(() => {});
  await hub.logout();
  await signOutLocal(null);
}

// ---- loading ----

let loading: Promise<void> | null = null;

/** Loads proxies, scores and logs from the server into session storage. */
export function loadAll(force = false): Promise<void> {
  if (!loading) {
    loading = (async () => {
      if (!(await isSignedIn())) return;
      const { loadedAt } = await getSession();
      if (!force && loadedAt && Date.now() - loadedAt < STALE_MS) return;
      // Send what is waiting first so the reloaded lists include it.
      await flush().catch(() => {});
      const [proxies, checks, logs] = await Promise.all([
        hub.get<{ items: ServerProxy[] }>("/relayswitch/proxies"),
        hub.get<{ stats: Record<string, { results: CheckResult[] }> }>("/relayswitch/checks"),
        hub.get<{ items: LogEntry[] }>(`/relayswitch/logs?limit=${LOG_LIMIT}`),
      ]);
      const list = (proxies.items ?? []).map(toProfile);
      const { activeProfileId } = await getLocal();
      // The selected proxy must still exist on the server.
      if (activeProfileId && !list.some((p) => p.id === activeProfileId)) {
        await setLocal({ activeProfileId: list[0]?.id ?? null });
      }
      await serial(async () => {
        const s = await getSession();
        await setSession({
          profiles: list,
          stats: checksToStats(checks.stats),
          // Keep entries recorded locally that are still on their way.
          logs: [...(logs.items ?? []), ...s.pendingLogs].slice(-LOG_LIMIT),
          loadedAt: Date.now(),
        });
      });
    })().finally(() => {
      loading = null;
    });
  }
  return loading;
}

// ---- proxies ----

// Proxies are added, edited and deleted only in the web panel (the server refuses these
// changes from the extension). The extension reads them and sends checks and logs.

export async function clearLogsRemote(): Promise<void> {
  await hub.del("/relayswitch/logs");
  await serial(() => setSession({ logs: [], pendingLogs: [] }));
}

// ---- sending logs and checks ----

let timer: ReturnType<typeof setTimeout> | undefined;
let flushing: Promise<void> | null = null;

export function scheduleFlush(ms = FLUSH_MS): void {
  if (timer !== undefined) return;
  timer = setTimeout(() => {
    timer = undefined;
    void flush().catch(() => {});
  }, ms);
}
onQueued(() => scheduleFlush());

/** Sends waiting logs and checks. On failure they are put back for the next try. */
export function flush(): Promise<void> {
  if (!flushing) {
    flushing = (async () => {
      if (!(await isSignedIn())) return;
      const { checks, logs } = await takePending();
      if (!checks.length && !logs.length) return;
      let sentChecks = 0;
      let sentLogs = 0;
      try {
        for (const part of chunk(checks, MAX_BATCH)) {
          await hub.post("/relayswitch/checks", { items: part });
          sentChecks += part.length;
        }
        for (const part of chunk(logs, MAX_BATCH)) {
          await hub.post("/relayswitch/logs", { items: part });
          sentLogs += part.length;
        }
      } catch (err) {
        // Signed out meanwhile: the data is gone with the sign-in.
        if (await isSignedIn()) {
          await requeue(checks.slice(sentChecks), logs.slice(sentLogs));
          scheduleFlush(FLUSH_MS * 6);
        }
        throw err;
      }
    })().finally(() => {
      flushing = null;
    });
  }
  return flushing;
}

// ---- upload of data saved by older versions ----

export async function legacyInfo(): Promise<LegacyInfo | null> {
  if (!(await isSignedIn())) return null;
  const old = await getLegacy();
  const info: LegacyInfo = {
    profiles: Array.isArray(old.profiles) ? old.profiles.length : 0,
    logs: Array.isArray(old.logs) ? old.logs.length : 0,
    checks: Object.values(old.stats ?? {}).reduce((n, s) => n + (Array.isArray(s?.results) ? s.results.length : 0), 0),
  };
  return info.profiles || info.logs || info.checks ? info : null;
}

/**
 * Proxies saved by RelaySwitch 0.1.x in this browser, one per line, ready to paste into
 * Bulk add on the web panel ("scheme://user:pass@host:port" or "scheme://host:port").
 */
export async function legacyProxyLines(): Promise<string> {
  const old = await getLegacy();
  const list = Array.isArray(old.profiles) ? old.profiles : [];
  return list
    .map((p) => {
      const auth = p.usernameTemplate ? `${p.usernameTemplate}${p.password ? ":" + p.password : ""}@` : "";
      return `${p.scheme || "http"}://${auth}${p.host}:${p.port}`;
    })
    .join("\n");
}

/** Forgets the data of older versions in this browser (after it was moved to the panel). */
export async function dropLegacy(): Promise<void> {
  await removeLegacy();
}
