// API client for the panel. The access token lives only in memory; the refresh
// token is the HttpOnly cookie `eh_rt` (path /api/v1/auth), so a reload restores
// the session with POST /auth/refresh.
const BASE = "/api/v1";
const RENEW_BEFORE_MS = 60_000;

let accessToken = null;
let accessExpiresAt = 0;
let renewTimer = null;
let refreshing = null;

export class ApiError extends Error {
  constructor(status, body) {
    super((body && body.message) || `Request failed (${status})`);
    this.status = status;
    this.code = (body && body.code) || "error";
    this.body = body || {};
  }
}

function tz() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (_) { return ""; }
}

function setAccess(data) {
  accessToken = data.accessToken;
  accessExpiresAt = data.accessExpiresAt || Date.now() + 9 * 60_000;
  clearTimeout(renewTimer);
  const wait = Math.max(5_000, accessExpiresAt - Date.now() - RENEW_BEFORE_MS);
  renewTimer = setTimeout(() => refresh().catch(() => {}), wait);
}

/** Role from the current access token (its payload is not secret; the server checks it on every call). */
export function tokenRole() {
  try {
    const part = accessToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(part)).role || null;
  } catch (_) {
    return null;
  }
}

function clearAccess() {
  accessToken = null;
  accessExpiresAt = 0;
  clearTimeout(renewTimer);
}

async function raw(method, path, body, { auth = true } = {}) {
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (auth && accessToken) headers.Authorization = "Bearer " + accessToken;
  const t = tz();
  if (t) headers["X-Timezone"] = t;
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
    });
  } catch (_) {
    throw new ApiError(0, { code: "network", message: "Can't reach the server. Check your connection." });
  }
  let data = null;
  const text = await res.text();
  if (text) {
    try { data = JSON.parse(text); } catch (_) { data = { message: text.slice(0, 200) }; }
  }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

/** Restores / renews the session from the refresh cookie. */
export function refresh() {
  if (!refreshing) {
    refreshing = raw("POST", "/auth/refresh", {}, { auth: false })
      .then((d) => { setAccess(d); return d; })
      .catch((e) => { clearAccess(); throw e; })
      .finally(() => { refreshing = null; });
  }
  return refreshing;
}

export function goLogin(expired) {
  const next = location.pathname + location.hash;
  const q = new URLSearchParams();
  if (expired) q.set("expired", "1");
  if (next && next !== "/login") q.set("next", next);
  location.href = "/login" + (q.toString() ? "?" + q : "");
}

const SIGNED_OUT = new Set(["session_expired", "not_signed_in", "account_disabled", "account_pending", "device_revoked"]);

/** Authenticated call: refresh once on an expired access token, retry once. */
export async function api(method, path, body) {
  if (!accessToken) {
    try { await refresh(); } catch (_) { goLogin(true); throw new ApiError(401, { code: "session_expired", message: "Please sign in again." }); }
  }
  try {
    return await raw(method, path, body);
  } catch (e) {
    if (e.status === 401 && e.code === "access_token_expired") {
      try { await refresh(); } catch (_) { goLogin(true); throw e; }
      return raw(method, path, body);
    }
    if (e.status === 401 && SIGNED_OUT.has(e.code)) {
      clearAccess();
      goLogin(true);
    }
    throw e;
  }
}

export const get = (p) => api("GET", p);
export const post = (p, b) => api("POST", p, b ?? {});
export const put = (p, b) => api("PUT", p, b ?? {});
export const del = (p) => api("DELETE", p);

export async function login(username, password) {
  const d = await raw("POST", "/auth/login", { username, password, client: { kind: "panel" } }, { auth: false });
  setAccess(d);
  return d;
}

export async function register(username, password, email) {
  return raw("POST", "/auth/register", { username, password, email: email || undefined }, { auth: false });
}

export async function logout() {
  try { if (accessToken) await raw("POST", "/auth/logout", {}); } catch (_) { /* ignore */ }
  clearAccess();
}

/** Builds a query string, skipping empty values. */
export function qs(params) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== "") u.set(k, v);
  const s = u.toString();
  return s ? "?" + s : "";
}

/**
 * Server-Sent Events over fetch (EventSource can't send the Bearer token).
 * onEvent(name, data) for each event; reconnects with backoff, refreshing the token first.
 * -> stop()
 */
export function stream(path, onEvent, { onOpen } = {}) {
  let stopped = false;
  let ctrl = null;
  let delay = 2000;
  async function connect() {
    while (!stopped) {
      try {
        if (!accessToken || accessExpiresAt - Date.now() < 30_000) await refresh();
        ctrl = new AbortController();
        const res = await fetch(BASE + path, { headers: { Accept: "text/event-stream", Authorization: "Bearer " + accessToken }, signal: ctrl.signal, credentials: "same-origin" });
        if (res.status === 401 || res.status === 403) {
          if (res.status === 403) return; // no CitaMate access: nothing to stream
          await refresh();
          continue;
        }
        if (!res.ok || !res.body) throw new Error("HTTP " + res.status);
        delay = 2000;
        if (onOpen) onOpen();
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            let name = "message";
            const data = [];
            for (const line of block.split("\n")) {
              if (line.startsWith("event:")) name = line.slice(6).trim();
              else if (line.startsWith("data:")) data.push(line.slice(5).trim());
            }
            if (data.length) {
              try { onEvent(name, JSON.parse(data.join("\n"))); } catch (_) { /* bad event: skip */ }
            }
          }
        }
      } catch (_) {
        if (stopped) return;
      }
      // Server ended the stream (every few minutes) or the network dropped: come back.
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 30_000);
    }
  }
  connect();
  return () => {
    stopped = true;
    if (ctrl) ctrl.abort();
  };
}
