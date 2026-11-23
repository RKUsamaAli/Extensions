'use strict';
/**
 * Proxy score - the same formula as RelaySwitch (relayswitch/src/core/score.ts) and the
 * panel (public/js/proxyScore.js), so every screen shows the same number.
 * 70 points for reliability, 30 for speed (median of OK checks: 300 ms = full, 3000 ms = none),
 * minus 15 when the latest check failed.
 */
const SCORE_WINDOW = 20;
const FAST_MS = 300;
const SLOW_MS = 3000;

function median(values) {
    const s = [...values].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** results oldest -> newest ({ t, ok, ms, ip, error }) */
function scoreOf(all = []) {
    const recent = all.slice(-SCORE_WINDOW);
    const last = recent[recent.length - 1];
    let lastIp = null;
    for (let i = recent.length - 1; i >= 0; i--) if (recent[i].ok && recent[i].ip) { lastIp = recent[i].ip; break; }
    if (!last) return { value: null, okCount: 0, samples: 0, reliability: null, medianMs: null, lastIp, lastChecked: null, lastOk: null, lastError: null };
    const okTimed = recent.filter((r) => r.ok && typeof r.ms === 'number');
    const okCount = recent.filter((r) => r.ok).length;
    const medianMs = okTimed.length ? Math.round(median(okTimed.map((r) => r.ms))) : null;
    const speed = medianMs === null ? 0 : Math.min(1, Math.max(0, (SLOW_MS - medianMs) / (SLOW_MS - FAST_MS)));
    let value = (okTimed.length / recent.length) * 70 + speed * 30;
    if (!last.ok) value -= 15;
    value = Math.round(Math.min(100, Math.max(0, value)));
    return { value, okCount, samples: recent.length, reliability: okCount / recent.length, medianMs, lastIp, lastChecked: last.t, lastOk: !!last.ok, lastError: last.ok ? null : last.error || null };
}

function scoreBand(value) {
    if (value === null || value === undefined) return 'none';
    if (value >= 80) return 'good';
    if (value >= 50) return 'fair';
    return 'poor';
}

module.exports = { scoreOf, scoreBand, SCORE_WINDOW };
