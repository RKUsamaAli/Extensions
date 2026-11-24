import type { CheckResult, LogEntry, ProxyProfile, ProxyStats, RuntimeState } from "../core/types";
import { newClientId, type ServerCheck } from "../core/hubdata";
import { displayName } from "../core/profile";
import { callApi } from "./api";
import { DEFAULT_API_BASE, LOG_LIMIT } from "./config";
import type { AuthInfo } from "./messages";

// local: survives restarts. Only settings and the sign-in live here.
// Proxies, scores and logs belong to the server; they are cached in session
// storage (cleared when the browser closes, never readable by content scripts).
interface LocalData {
  enabled: boolean;
  activeProfileId: string | null;
  floatingButton: boolean;
  /** On-page button position: which edge, and distance from the top in %. */
  fabPos: { side: "left" | "right"; top: number };
  /** ext-hub server address. */
  apiBase: string;
  /** Random id of this install, sent as X-Device-Id. */
  deviceId: string;
  /** Long-lived token used only to get access tokens. Null = signed out. */
  refreshToken: string | null;
}

interface SessionData {
  sessionId: number | null;
  authFailures: number;
  status: RuntimeState["status"];
  statusDetail: string;
  exitIp: string | null;
  checkedAt: number | null;
  latencyMs: number | null;
  /** Progress of a Test all / Test run, shown on the options page. */
  testRun: TestRun | null;
  /** Login challenges seen for the proxy under test. */
  testAuthTries: number;
  /** The browser has proxy.settings but it never answers (e.g. Orion on iOS).
   * Remembered until the browser restarts so we don't wait again each time. */
  proxyUnresponsive: boolean;

  // ---- server sign-in and cached server data ----
  accessToken: string | null;
  accessExpiresAt: number | null;
  /** Signed-in user and access, from the last bootstrap. */
  auth: AuthInfo | null;
  /** Why the last sign-in ended or failed, shown on the sign-in form. */
  authError: string | null;
  profiles: ProxyProfile[];
  /** Check history per proxy id, used for the score. */
  stats: Record<string, ProxyStats>;
  logs: LogEntry[];
  /** When profiles/stats/logs were last loaded from the server. */
  loadedAt: number | null;
  /** Not yet sent to the server. */
  pendingChecks: ServerCheck[];
  pendingLogs: LogEntry[];
}

export interface TestRun {
  running: boolean;
  done: number;
  total: number;
  currentId: string | null;
  cancelled: boolean;
  startedAt: number;
}

const LOCAL_DEFAULTS: LocalData = {
  enabled: false,
  activeProfileId: null,
  floatingButton: false,
  fabPos: { side: "right", top: 50 }, // CitaMate's button defaults to 70%: keep them apart
  apiBase: DEFAULT_API_BASE,
  deviceId: "",
  refreshToken: null,
};

const SESSION_DEFAULTS: SessionData = {
  sessionId: null,
  authFailures: 0,
  status: "off",
  statusDetail: "",
  exitIp: null,
  checkedAt: null,
  latencyMs: null,
  testRun: null,
  testAuthTries: 0,
  proxyUnresponsive: false,
  accessToken: null,
  accessExpiresAt: null,
  auth: null,
  authError: null,
  profiles: [],
  stats: {},
  logs: [],
  loadedAt: null,
  pendingChecks: [],
  pendingLogs: [],
};

/** Keys older versions kept in storage.local; read once for the upload. */
export const LEGACY_KEYS = ["profiles", "logs", "stats"] as const;

export async function getLocal(): Promise<LocalData> {
  const data = await callApi<Record<string, unknown>>("storage.local.get", (cb) => chrome.storage.local.get(LOCAL_DEFAULTS as unknown as Record<string, unknown>, cb));
  return { ...LOCAL_DEFAULTS, ...(data ?? {}) } as LocalData;
}

export async function setLocal(patch: Partial<LocalData>): Promise<void> {
  await callApi("storage.local.set", (cb) => chrome.storage.local.set(patch, () => cb()));
}

/** The id of this install; created once. */
export async function deviceId(): Promise<string> {
  const { deviceId: id } = await getLocal();
  if (id) return id;
  const fresh = crypto.randomUUID();
  await setLocal({ deviceId: fresh });
  return fresh;
}

export interface LegacyData {
  profiles?: ProxyProfile[];
  logs?: LogEntry[];
  stats?: Record<string, ProxyStats>;
}

export async function getLegacy(): Promise<LegacyData> {
  const data = await callApi<Record<string, unknown>>("storage.local.get", (cb) => chrome.storage.local.get([...LEGACY_KEYS], cb));
  return (data ?? {}) as LegacyData;
}

export async function removeLegacy(): Promise<void> {
  await callApi("storage.local.remove", (cb) => chrome.storage.local.remove([...LEGACY_KEYS], () => cb()));
}

// Some browsers have no storage.session; fall back to memory there.
const memorySession: Partial<SessionData> = {};
const hasSessionStorage = () => {
  try {
    return typeof chrome.storage?.session?.get === "function";
  } catch {
    return false;
  }
};

export async function getSession(): Promise<SessionData> {
  if (!hasSessionStorage()) return { ...SESSION_DEFAULTS, ...memorySession };
  const data = await callApi<Record<string, unknown>>("storage.session.get", (cb) =>
    chrome.storage.session.get(SESSION_DEFAULTS as unknown as Record<string, unknown>, cb),
  );
  return { ...SESSION_DEFAULTS, ...(data ?? {}) } as SessionData;
}

export async function setSession(patch: Partial<SessionData>): Promise<void> {
  if (!hasSessionStorage()) {
    Object.assign(memorySession, patch);
    return;
  }
  await callApi("storage.session.set", (cb) => chrome.storage.session.set(patch, () => cb()));
}

/** Forget every piece of server data held by this browser. */
export async function clearServerData(): Promise<void> {
  await setSession({
    accessToken: null,
    accessExpiresAt: null,
    auth: null,
    profiles: [],
    stats: {},
    logs: [],
    loadedAt: null,
    pendingChecks: [],
    pendingLogs: [],
  });
}

export async function profiles(): Promise<ProxyProfile[]> {
  return (await getSession()).profiles;
}

export async function activeProfile(): Promise<ProxyProfile | null> {
  const { activeProfileId } = await getLocal();
  const list = await profiles();
  return list.find((p) => p.id === activeProfileId) ?? list[0] ?? null;
}

/** Log fields that tie an entry to a proxy. */
export function who(profile: ProxyProfile | null | undefined): Pick<LogEntry, "profile" | "profileId"> {
  return profile ? { profile: displayName(profile), profileId: profile.id } : {};
}

const KEEP_RESULTS = 50;

// Log and stats updates are read-modify-write; run them one at a time so
// concurrent events (e.g. during Test all) don't overwrite each other.
let queue: Promise<unknown> = Promise.resolve();
export function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

/** Called after something was queued for the server (the worker schedules a flush). */
let queued: () => void = () => {};
export function onQueued(fn: () => void): void {
  queued = fn;
}

/** Signed in = there is a refresh token. Nothing is recorded while signed out. */
async function signedIn(): Promise<boolean> {
  return !!(await getLocal()).refreshToken;
}

export function recordResult(profileId: string, result: CheckResult): Promise<void> {
  return serial(async () => {
    if (!(await signedIn())) return;
    const { stats, pendingChecks } = await getSession();
    const entry = stats[profileId] ?? { results: [] };
    entry.results = [...entry.results, result].slice(-KEEP_RESULTS);
    stats[profileId] = entry;
    await setSession({ stats, pendingChecks: [...pendingChecks, { ...result, proxyId: profileId, id: newClientId() }] });
    queued();
  });
}

export function dropStats(profileId: string): Promise<void> {
  return serial(async () => {
    const { stats, pendingChecks } = await getSession();
    delete stats[profileId];
    await setSession({ stats, pendingChecks: pendingChecks.filter((c) => c.proxyId !== profileId) });
  });
}

export function clearLogsLocal(): Promise<void> {
  return serial(() => setSession({ logs: [], pendingLogs: [] }));
}

export function log(entry: Omit<LogEntry, "t">): Promise<void> {
  return serial(async () => {
    if (!(await signedIn())) return;
    const { logs, pendingLogs } = await getSession();
    const item: LogEntry = { id: newClientId(), t: Date.now(), ...entry };
    logs.push(item);
    await setSession({ logs: logs.slice(-LOG_LIMIT), pendingLogs: [...pendingLogs, item].slice(-LOG_LIMIT) });
    queued();
  });
}

/** Takes what is waiting to be sent; put it back with requeue() if sending fails. */
export function takePending(): Promise<{ checks: ServerCheck[]; logs: LogEntry[] }> {
  return serial(async () => {
    const { pendingChecks, pendingLogs } = await getSession();
    if (pendingChecks.length || pendingLogs.length) await setSession({ pendingChecks: [], pendingLogs: [] });
    return { checks: pendingChecks, logs: pendingLogs };
  });
}

export function requeue(checks: ServerCheck[], logs: LogEntry[]): Promise<void> {
  return serial(async () => {
    const s = await getSession();
    await setSession({
      pendingChecks: [...checks, ...s.pendingChecks].slice(-LOG_LIMIT),
      pendingLogs: [...logs, ...s.pendingLogs].slice(-LOG_LIMIT),
    });
  });
}

export async function runtimeState(): Promise<RuntimeState> {
  const local = await getLocal();
  const session = await getSession();
  const profile = await activeProfile();
  return {
    enabled: local.enabled,
    activeProfileId: profile?.id ?? null,
    sessionId: session.sessionId,
    status: session.status,
    statusDetail: session.statusDetail,
    exitIp: session.exitIp,
    checkedAt: session.checkedAt,
    latencyMs: session.latencyMs,
  };
}
