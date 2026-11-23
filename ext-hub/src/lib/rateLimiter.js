'use strict';
/**
 * Fixed-window counters in memory (one process). Used for failed logins and the
 * per-user API limit. With several processes each keeps its own counters, which is
 * fine as a second line behind nginx's per-IP limits.
 */
function createLimiter({ limit, windowMs, now = () => Date.now() }) {
    const hits = new Map(); // key -> { count, resetAt }

    function state(key) {
        const t = now();
        let s = hits.get(key);
        if (!s || s.resetAt <= t) {
            s = { count: 0, resetAt: t + windowMs };
            hits.set(key, s);
        }
        return s;
    }

    return {
        /** Adds `weight` hits. -> { allowed, remaining, retryAfterSec } */
        hit(key, weight = 1) {
            const s = state(key);
            s.count += weight;
            const allowed = s.count <= limit;
            return { allowed, remaining: Math.max(0, limit - s.count), retryAfterSec: Math.ceil((s.resetAt - now()) / 1000) };
        },
        /** True when the key is already over the limit (does not count). */
        blocked(key) {
            const s = hits.get(key);
            return !!s && s.resetAt > now() && s.count >= limit;
        },
        retryAfter(key) {
            const s = hits.get(key);
            return s ? Math.max(1, Math.ceil((s.resetAt - now()) / 1000)) : 0;
        },
        reset(key) {
            hits.delete(key);
        },
        /** Drops finished windows (called by the maintenance job). */
        sweep() {
            const t = now();
            for (const [k, s] of hits) if (s.resetAt <= t) hits.delete(k);
        }
    };
}

module.exports = { createLimiter };
