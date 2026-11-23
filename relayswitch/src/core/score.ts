import type { CheckResult } from "./types";

/** How many recent results the score looks at. */
export const SCORE_WINDOW = 20;
/** At or under this response time a proxy gets full speed points. */
export const FAST_MS = 300;
/** At or over this response time it gets none. */
export const SLOW_MS = 3000;

export interface Score {
  /** 0..100, or null when the proxy has never been checked. */
  value: number | null;
  /** Share of recent checks that worked, 0..1. */
  reliability: number | null;
  /** Median response time of recent successful checks. */
  medianMs: number | null;
  samples: number;
  lastIp: string | null;
  lastChecked: number | null;
  lastOk: boolean | null;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Score out of 100 from the last SCORE_WINDOW checks:
 * - 70 points for reliability (share of checks that worked)
 * - 30 points for speed (median response time, FAST_MS = full, SLOW_MS = none)
 * - minus 15 if the most recent check failed, so a proxy that just broke
 *   drops below ones that are working now
 */
export function scoreOf(all: CheckResult[]): Score {
  const recent = all.slice(-SCORE_WINDOW);
  const last = recent[recent.length - 1];
  const lastIp = [...recent].reverse().find((r) => r.ok && r.ip)?.ip ?? null;
  if (!last) {
    return { value: null, reliability: null, medianMs: null, samples: 0, lastIp, lastChecked: null, lastOk: null };
  }
  const ok = recent.filter((r) => r.ok && typeof r.ms === "number");
  const reliability = ok.length / recent.length;
  const medianMs = ok.length ? Math.round(median(ok.map((r) => r.ms!))) : null;
  const speed = medianMs === null ? 0 : Math.min(1, Math.max(0, (SLOW_MS - medianMs) / (SLOW_MS - FAST_MS)));
  let value = reliability * 70 + speed * 30;
  if (!last.ok) value -= 15;
  value = Math.round(Math.min(100, Math.max(0, value)));
  return { value, reliability, medianMs, samples: recent.length, lastIp, lastChecked: last.t, lastOk: last.ok };
}

export type ScoreBand = "good" | "fair" | "poor" | "none";

export function scoreBand(value: number | null): ScoreBand {
  if (value === null) return "none";
  if (value >= 80) return "good";
  if (value >= 50) return "fair";
  return "poor";
}

/** Sorts best score first; never-checked proxies last; ties by name. */
export function byBestScore<T extends { id: string }>(scores: Record<string, number | null | undefined>, name: (p: T) => string) {
  return (a: T, b: T): number => {
    const x = scores[a.id] ?? null;
    const y = scores[b.id] ?? null;
    if (x !== y) {
      if (x === null) return 1;
      if (y === null) return -1;
      return y - x;
    }
    return name(a).localeCompare(name(b), undefined, { numeric: true, sensitivity: "base" });
  };
}
