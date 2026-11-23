'use strict';
/** Small helpers shared by services and routes. */

const EXTS = Object.freeze(['citamate', 'relayswitch']);
const isExt = (v) => EXTS.includes(v);

/** "1.10.2" > "1.9" -> 1. Non-numeric parts count as 0. */
function compareVersions(a, b) {
    const pa = String(a || '0').split('.').map((x) => Number.parseInt(x, 10) || 0);
    const pb = String(b || '0').split('.').map((x) => Number.parseInt(x, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d) return d > 0 ? 1 : -1;
    }
    return 0;
}

/** "citamate/1.6.0" -> { ext: 'citamate', version: '1.6.0' } | null */
function parseClientHeader(v) {
    const m = /^([a-z]+)\/([0-9][0-9A-Za-z.+-]{0,30})$/.exec(String(v || '').trim());
    return m ? { ext: m[1], version: m[2] } : null;
}

/** Trimmed string, capped. null/undefined -> ''. */
function str(v, max = 500) {
    if (v === null || v === undefined) return '';
    return String(v).trim().slice(0, max);
}

/** Integer in [min,max] or the default. */
function clampInt(v, min, max, def) {
    const n = Number.parseInt(v, 10);
    if (!Number.isFinite(n)) return def;
    return Math.min(max, Math.max(min, n));
}

function parseJson(text, fallback) {
    try {
        return JSON.parse(text);
    } catch (_) {
        return fallback;
    }
}

module.exports = { EXTS, isExt, compareVersions, parseClientHeader, str, clampInt, parseJson };
