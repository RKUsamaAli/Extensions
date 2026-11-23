import type { CheckResult, LogEntry, ProxyProfile, ProxyStats, RuntimeState } from "../core/types";
import { displayName } from "../core/profile";
import { callApi } from "./api";
import { LOG_LIMIT } from "./config";

// local: survives restarts. session: cleared when the browser closes.
interface LocalData {
  profiles: ProxyProfile[];
  enabled: boolean;
  activeProfileId: string | null;
  logs: LogEntry[];
  floatingButton: boolean;
  /** On-page button position: which edge, and distance from the top in %. */
  fabPos: { side: "left" | "right"; top: number };
  /** Check history per proxy id, used for the score. */
  stats: Record<string, ProxyStats>;
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
  profiles: [],
  enabled: false,
  activeProfileId: null,
  logs: [],
  floatingButton: false,
  fabPos: { side: "right", top: 70 },
  stats: {},
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
};

export async function getLocal(): Promise<LocalData> {
  const data = await callApi<Record<string, unknown>>("storage.local.get", (cb) => chrome.storage.local.get(LOCAL_DEFAULTS as unknown as Record<string, unknown>, cb));
  return { ...LOCAL_DEFAULTS, ...(data ?? {}) } as LocalData;
}

export async function setLocal(patch: Partial<LocalData>): Promise<void> {
  await callApi("storage.local.set", (cb) => chrome.storage.local.set(patch, () => cb()));
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

export async function activeProfile(): Promise<ProxyProfile | null> {
  const { profiles, activeProfileId } = await getLocal();
  return profiles.find((p) => p.id === activeProfileId) ?? profiles[0] ?? null;
}

/** Log fields that tie an entry to a proxy. */
export function who(profile: ProxyProfile | null | undefined): Pick<LogEntry, "profile" | "profileId"> {
  return profile ? { profile: displayName(profile), profileId: profile.id } : {};
}

const KEEP_RESULTS = 50;

// Log and stats updates are read-modify-write; run them one at a time so
// concurrent events (e.g. during Test all) don't overwrite each other.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

export function recordResult(profileId: string, result: CheckResult): Promise<void> {
  return serial(async () => {
  const { stats } = await getLocal();
  const entry = stats[profileId] ?? { results: [] };
  entry.results = [...entry.results, result].slice(-KEEP_RESULTS);
  stats[profileId] = entry;
  await setLocal({ stats });
  });
}

export function dropStats(profileId: string): Promise<void> {
  return serial(async () => {
    const { stats } = await getLocal();
    delete stats[profileId];
    await setLocal({ stats });
  });
}

export function clearLogs(): Promise<void> {
  return serial(() => setLocal({ logs: [] }));
}

export function log(entry: Omit<LogEntry, "t">): Promise<void> {
  return serial(async () => {
    const { logs } = await getLocal();
    logs.push({ t: Date.now(), ...entry });
    await setLocal({ logs: logs.slice(-LOG_LIMIT) });
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
