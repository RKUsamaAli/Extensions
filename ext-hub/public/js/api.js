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
