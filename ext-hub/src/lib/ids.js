'use strict';
/**
 * GUIDs for every table: UUID version 7 (RFC 9562).
 *
 *   01936a7e-5b2c-7d41-9f3e-8c2a1b4d6e0f
 *   |--- ms time ---|   |---- random ----|
 *
 * Unguessable (74 random bits) but they sort by creation time, so
 *   - B-tree indexes stay compact (inserts append at the end, like integers)
 *   - "newest first" is just ORDER BY id DESC (used by the scroll paging)
 * Ids created in the same millisecond by one process still sort in order
 * (a counter fills the first random bits).
 */
const crypto = require('crypto');

let lastMs = 0;
let seq = 0;

function newId(now = Date.now()) {
    if (now <= lastMs) {
        now = lastMs;
        seq = (seq + 1) & 0xfff;
        if (seq === 0) now = ++lastMs; // 4096 ids in one ms: borrow the next ms
    } else {
        lastMs = now;
        seq = crypto.randomInt(0, 0x800); // random start keeps ids unguessable
    }
    const b = crypto.randomBytes(16);
    b.writeUIntBE(now, 0, 6); // 48-bit timestamp
    b[6] = 0x70 | (seq >> 8); // version 7 + 4 bits of sequence
    b[7] = seq & 0xff;
    b[8] = (b[8] & 0x3f) | 0x80; // RFC variant
    const h = b.toString('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** True for a well-formed GUID (used to validate ids from URLs / bodies). */
function isId(v) {
    return typeof v === 'string' && UUID_RE.test(v);
}
/** A GUID from user input, or null. */
function idOrNull(v) {
    return isId(v) ? v : null;
}

module.exports = { newId, isId, idOrNull };
