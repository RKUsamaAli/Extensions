// Proxy score: same formula as RelaySwitch (relayswitch/src/core/score.ts), so the
// panel and the extension show the same numbers.
export const SCORE_WINDOW = 20;
const FAST_MS = 300;
const SLOW_MS = 3000;

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * results: checks oldest -> newest ({ t, ok, ms, ip, error, source }).
 * -> { value 0..100|null, okCount, samples, reliability, medianMs, lastIp, lastChecked, lastOk, lastError }
 * 70 points for reliability, 30 for speed (median of OK checks), minus 15 if the latest check failed.
 */
export function scoreOf(all = []) {
  const recent = all.slice(-SCORE_WINDOW);
  const last = recent[recent.length - 1];
  const lastIp = [...recent].reverse().find((r) => r.ok && r.ip)?.ip ?? null;
  if (!last) return { value: null, okCount: 0, samples: 0, reliability: null, medianMs: null, lastIp, lastChecked: null, lastOk: null, lastError: null };
  const ok = recent.filter((r) => r.ok && typeof r.ms === "number");
  const reliability = recent.filter((r) => r.ok).length / recent.length;
  const medianMs = ok.length ? Math.round(median(ok.map((r) => r.ms))) : null;
  const speed = medianMs === null ? 0 : Math.min(1, Math.max(0, (SLOW_MS - medianMs) / (SLOW_MS - FAST_MS)));
  let value = (ok.length / recent.length) * 70 + speed * 30;
  if (!last.ok) value -= 15;
  value = Math.round(Math.min(100, Math.max(0, value)));
  return {
    value,
    okCount: recent.filter((r) => r.ok).length,
    samples: recent.length,
    reliability,
    medianMs,
    lastIp,
    lastChecked: last.t,
    lastOk: !!last.ok,
    lastError: last.ok ? null : last.error || null,
  };
}

/** "good" (80+), "fair" (50+), "poor", or "none" when never checked. */
export function scoreBand(value) {
  if (value === null || value === undefined) return "none";
  if (value >= 80) return "good";
  if (value >= 50) return "fair";
  return "poor";
}
