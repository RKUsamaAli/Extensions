import { parseProxyLine, type ParsedProxy } from "./parse";
import type { Scheme } from "./types";

export interface BulkLine extends ParsedProxy {
  line: number;
}

export interface BulkError {
  line: number;
  text: string;
  error: string;
}

export interface BulkResult {
  proxies: BulkLine[];
  errors: BulkError[];
  /** Lines skipped because the same host:port:username appeared earlier. */
  duplicates: number;
}

export const proxyKey = (p: { host: string; port: number; username: string }) =>
  `${p.host.toLowerCase()}:${p.port}:${p.username}`;

/** Parse one proxy per line. Blank lines and lines starting with # are ignored.
 * `existing` keys (from proxies already saved) count as duplicates too. */
export function parseBulk(text: string, defaultScheme: Scheme, existing: Set<string> = new Set()): BulkResult {
  const seen = new Set(existing);
  const result: BulkResult = { proxies: [], errors: [], duplicates: 0 };
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    try {
      const p = parseProxyLine(line, defaultScheme);
      const key = proxyKey(p);
      if (seen.has(key)) {
        result.duplicates++;
        return;
      }
      seen.add(key);
      result.proxies.push({ ...p, line: i + 1 });
    } catch (err) {
      result.errors.push({ line: i + 1, text: line, error: err instanceof Error ? err.message : String(err) });
    }
  });
  return result;
}

export type NameBy = "host" | "username" | "none";

/** Names for a bulk batch. "host" uses the server; when several proxies share
 * a host (e.g. one gateway, many usernames) the username is added so each
 * name stays distinct. */
export function bulkNames(proxies: ParsedProxy[], by: NameBy): string[] {
  if (by === "none") return proxies.map(() => "");
  if (by === "username") return proxies.map((p) => p.username || p.host);
  const hostCount = new Map<string, number>();
  for (const p of proxies) hostCount.set(p.host, (hostCount.get(p.host) ?? 0) + 1);
  return proxies.map((p) =>
    (hostCount.get(p.host) ?? 0) > 1 ? `${p.host} · ${p.username || p.port}` : p.host,
  );
}
