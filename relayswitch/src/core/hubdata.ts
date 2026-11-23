// Pure helpers for talking to the ext-hub server: shaping proxies for the API,
// splitting uploads into batches and moving old local data to the server.
import type { CheckResult, LogEntry, ProxyProfile, ProxyStats, Scheme } from "./types";

/** A proxy as the server returns it: a ProxyProfile plus ownership fields. */
export interface ServerProxy extends ProxyProfile {
  ownerId?: string;
  ownerName?: string;
  createdAt?: number;
  updatedAt?: number;
}

/** A check as the server stores it: CheckResult plus the proxy it belongs to. */
export interface ServerCheck extends CheckResult {
  proxyId: string;
  /** Client id; the server ignores a repeated one, so a resend is never stored twice. */
  id?: string;
}

/** A new id for a queued log or check. */
export function newClientId(): string {
  return crypto.randomUUID();
}

const SCHEMES: Scheme[] = ["http", "https", "socks4", "socks5"];

/** Keep only the ProxyProfile fields of a server item (drops ownership fields). */
export function toProfile(item: ServerProxy): ProxyProfile {
  return {
    id: String(item.id),
    name: String(item.name ?? ""),
    scheme: SCHEMES.includes(item.scheme) ? item.scheme : "http",
    host: String(item.host ?? ""),
    port: Number(item.port) || 0,
    usernameTemplate: String(item.usernameTemplate ?? ""),
    password: String(item.password ?? ""),
    country: String(item.country ?? ""),
    city: String(item.city ?? ""),
    sessionStart: Number(item.sessionStart) || 0,
    sessionEnd: Number(item.sessionEnd) || 0,
  };
}

/** Request body for create/update: every proxy field except the id. */
export function profileBody(p: ProxyProfile): Omit<ProxyProfile, "id"> {
  const { id: _id, ...rest } = toProfile(p);
  return rest;
}

/** Splits a list into batches of at most `size` (the API caps batch sizes). */
export function chunk<T>(list: readonly T[], size: number): T[][] {
  if (size < 1) throw new Error("chunk size must be at least 1");
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * Old local id → new server id. The bulk endpoint returns the created items in
 * the order they were sent, so the mapping is by position.
 */
export function remapIds(sent: readonly Pick<ProxyProfile, "id">[], created: readonly Pick<ProxyProfile, "id">[]): Map<string, string> {
  if (sent.length !== created.length) throw new Error(`Server created ${created.length} of ${sent.length} proxies`);
  const map = new Map<string, string>();
  sent.forEach((p, i) => map.set(p.id, created[i]!.id));
  return map;
}

/** Local score history → server checks with the new proxy ids. Unknown ids are dropped. */
export function statsToChecks(stats: Record<string, ProxyStats> | undefined, ids: Map<string, string>): ServerCheck[] {
  const out: ServerCheck[] = [];
  for (const [oldId, entry] of Object.entries(stats ?? {})) {
    const proxyId = ids.get(oldId);
    if (!proxyId || !Array.isArray(entry?.results)) continue;
    // Fixed ids: uploading the same old data again doesn't store it twice.
    entry.results.forEach((r, i) => out.push({ ...r, proxyId, id: `legacy-check:${oldId}:${r.t}:${i}` }));
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Server check list → the per-proxy stats shape the score code uses. */
export function checksToStats(stats: Record<string, { results: CheckResult[] }> | undefined): Record<string, ProxyStats> {
  const out: Record<string, ProxyStats> = {};
  for (const [id, entry] of Object.entries(stats ?? {})) {
    out[id] = { results: Array.isArray(entry?.results) ? entry.results : [] };
  }
  return out;
}

/** Local logs with proxy ids moved to the new server ids (names are kept), each with a fixed id. */
export function remapLogs(logs: readonly LogEntry[] | undefined, ids: Map<string, string>): LogEntry[] {
  return (logs ?? []).map((l, i) => {
    // Fixed ids: uploading the same old data again doesn't store it twice.
    const copy: LogEntry = { ...l, id: l.id ?? `legacy-log:${l.t}:${i}` };
    if (!l.profileId) return copy;
    const next = ids.get(l.profileId);
    if (next) copy.profileId = next;
    else delete copy.profileId;
    return copy;
  });
}

/**
 * Checks and tidies a server address typed by the user:
 * "localhost:4000/" → "http://localhost:4000". Throws on anything that isn't http(s).
 */
export function normalizeApiBase(input: string): string {
  let text = String(input ?? "").trim();
  if (!text) throw new Error("Enter the server address");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `${/^(localhost|127\.|\[::1\])/i.test(text) ? "http" : "https"}://${text}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`Invalid server address: ${input}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("The server address must start with http:// or https://");
  if (url.username || url.password) throw new Error("The server address can't contain a login");
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${path}`;
}

/** Host name of the server, so proxy rules can send API traffic DIRECT. */
export function apiHost(apiBase: string): string | null {
  try {
    return new URL(apiBase).hostname.replace(/^\[|\]$/g, "") || null;
  } catch {
    return null;
  }
}
