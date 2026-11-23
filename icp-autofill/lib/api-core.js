// CitaMate's ext-hub API client (see ext-hub/docs/API.md). Used only by the service worker.
//
// Where things live:
//   chrome.storage.local    cm.apiBase, cm.deviceId, cm.refresh (refresh token), cm.signoutReason
//   chrome.storage.session  cm.access { token, exp }, cm.user and every cached data key
// Nothing else is written to disk, so a copy of the extension without a sign-in has no data.
//
// Pure: storage, fetch, clock and uuid are injected, so Node tests can drive it with fakes.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.CM_API = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const K = {
    base: "cm.apiBase",
    device: "cm.deviceId",
    refresh: "cm.refresh",
    reason: "cm.signoutReason",
    access: "cm.access",
    user: "cm.user",
  };

  // Server answers that end the sign-in: tokens and the session cache are wiped.
  const FATAL = new Set([
    "not_signed_in",
    "session_expired",
    "subscription_expired",
    "account_disabled",
    "account_pending",
    "device_revoked",
    "device_limit",
    "no_entitlement",
  ]);

  const day = (t) => {
    try {
      return new Date(t).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
    } catch (_) {
      return String(t);
    }
  };

  function friendly(code, data, status) {
    const d = data || {};
    switch (code) {
      case "network":
        return "Can't reach the CitaMate server. CitaMate needs the server to work – check your internet connection or the server address.";
      case "invalid_credentials":
        return "Wrong username or password.";
      case "not_signed_in":
      case "session_expired":
        return "Your sign-in has expired. Please sign in again.";
      case "account_disabled":
        return "Your account is disabled. Contact your admin.";
      case "account_pending":
        return "Your account is waiting for admin approval.";
      case "no_entitlement":
        return "Your account has no access to CitaMate. Contact your admin.";
      case "subscription_expired":
        return "Your CitaMate access expired" + (d.expiresAt ? " on " + day(d.expiresAt) : "") + ". Contact your admin to extend it.";
      case "device_limit":
        return "Device limit reached" + (d.maxDevices ? " (" + d.maxDevices + " allowed)" : "") + ". Ask your admin to remove an old device.";
      case "device_revoked":
        return "This browser was signed out by an admin. Sign in again if you still have access.";
      case "update_required":
        return "Please update CitaMate" + (d.minVersion ? " to version " + d.minVersion + " or newer" : "") + ".";
      case "ext_disabled":
        return "CitaMate is switched off on the server right now. Try again later.";
      case "too_many_requests":
        return "Too many requests – wait " + (d.retryAfter ? d.retryAfter + " s" : "a moment") + " and try again.";
      case "validation_error": {
        const f = d.fields && typeof d.fields === "object" ? Object.entries(d.fields).map(([k, v]) => k + ": " + v) : [];
        return f.length ? "Please fix: " + f.join("; ") : d.message || "Some values are not valid.";
      }
      case "forbidden":
        return d.message || "You are not allowed to do that.";
      case "not_found":
        return d.message || "Not found – it may have been deleted.";
      default:
        return d.message || "Server error" + (status ? " (" + status + ")" : "") + ".";
    }
  }

  class ApiError extends Error {
    constructor(code, message, status, extra) {
      super(message);
      this.name = "ApiError";
      this.code = code;
      this.status = status || 0;
      this.extra = extra || {};
    }
    toJSON() {
      return { code: this.code, message: this.message, status: this.status, ...this.extra };
    }
  }

  /** "https://x.y/" → "https://x.y"; throws on anything that isn't an http(s) URL. */
  function normalizeBase(url) {
    const s = String(url || "").trim().replace(/\/+$/, "");
    let u;
    try {
      u = new URL(s);
    } catch (_) {
      throw new ApiError("bad_server", "Server address must look like https://api.example.com");
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new ApiError("bad_server", "Server address must start with https://");
    return s;
  }

  /**
   * @param {object} o
   * @param {Function} o.fetch                 fetch implementation
   * @param {object}   o.store                 { get(area, keys) → obj, set(area, obj), remove(area, keys), clear(area) }
   * @param {string}   o.version               extension version (X-Client)
   * @param {string}   o.defaultBase           default server address
   * @param {string}   [o.ext="citamate"]
   * @param {string}   [o.deviceName]
   * @param {Function} [o.now]                 clock (ms)
   * @param {Function} [o.uuid]                id generator for the device id
   * @param {Function} [o.onSignedOut]         called with the reason after a forced sign-out
   */
  function createClient(o) {
    const ext = o.ext || "citamate";
    const now = o.now || (() => Date.now());
    const uuid = o.uuid || (() => globalThis.crypto.randomUUID());
    const store = o.store;
    let refreshing = null;

    async function getLocal(key) {
      const got = await store.get("local", [key]);
      return got ? got[key] : undefined;
    }
    async function getSession(key) {
      const got = await store.get("session", [key]);
      return got ? got[key] : undefined;
    }

    async function base() {
      return (await getLocal(K.base)) || o.defaultBase;
    }

    async function deviceId() {
      let id = await getLocal(K.device);
      if (!id) {
        id = uuid();
        await store.set("local", { [K.device]: id });
      }
      return id;
    }

    async function headers(token, hasBody) {
      const h = { Accept: "application/json", "X-Client": ext + "/" + o.version, "X-Device-Id": await deviceId() };
      if (hasBody) h["Content-Type"] = "application/json";
      if (token) h.Authorization = "Bearer " + token;
      return h;
    }

    /** One HTTP call. Resolves { status, data } for any HTTP answer, throws ApiError("network") otherwise. */
    async function raw(method, path, body, token) {
      const url = (await base()) + "/api/v1" + path;
      let res;
      try {
        res = await o.fetch(url, {
          method,
          headers: await headers(token, body !== undefined),
          body: body === undefined ? undefined : JSON.stringify(body),
          credentials: "omit",
          cache: "no-store",
        });
      } catch (_) {
        throw new ApiError("network", friendly("network"));
      }
      let data = null;
      try {
        const text = await res.text();
        data = text ? JSON.parse(text) : null;
      } catch (_) {
        data = null;
      }
      return { status: res.status, data };
    }

    function toError(r) {
      const data = r.data || {};
      const code = data.code || (r.status >= 500 ? "server_error" : "http_" + r.status);
      const { code: _c, message: _m, ...extra } = data;
      return new ApiError(code, friendly(code, data, r.status), r.status, extra);
    }

    async function signOut(reason) {
      await store.remove("local", [K.refresh]);
      if (reason) await store.set("local", { [K.reason]: reason });
      await store.clear("session");
      if (o.onSignedOut) {
        try {
          await o.onSignedOut(reason || "");
        } catch (_) {}
      }
    }

    /** Wipes the sign-in when the server says it is over, then rethrows. */
    async function fail(err) {
      if (err instanceof ApiError && FATAL.has(err.code)) await signOut(err.message);
      throw err;
    }

    async function saveAccess(data) {
      await store.set("session", { [K.access]: { token: data.accessToken, exp: Number(data.accessExpiresAt) || now() + 5 * 60e3 } });
      return data.accessToken;
    }

    /** Refresh token → new access token. Concurrent callers share one request. */
    function refresh() {
      if (refreshing) return refreshing;
      refreshing = (async () => {
        const rt = await getLocal(K.refresh);
        if (!rt) throw new ApiError("not_signed_in", friendly("not_signed_in"), 401);
        const r = await raw("POST", "/auth/refresh", { refreshToken: rt });
        if (r.status !== 200 || !r.data || !r.data.accessToken) {
          const err = toError(r);
          // A rejected refresh token always means "sign in again".
          if (r.status === 401 && !FATAL.has(err.code)) err.code = "session_expired";
          return fail(err);
        }
        return saveAccess(r.data);
      })().finally(() => {
        refreshing = null;
      });
      return refreshing;
    }

    async function accessToken() {
      const a = await getSession(K.access);
      if (a && a.token && a.exp - 15000 > now()) return a.token;
      return refresh();
    }

    /**
     * Signed-in API call. On 401 access_token_expired: refresh once, retry once.
     * @returns parsed JSON body
     */
    async function request(method, path, body) {
      let token = await accessToken();
      let r = await raw(method, path, body, token);
      if (r.status === 401 && r.data && r.data.code === "access_token_expired") {
        await store.remove("session", [K.access]);
        token = await refresh();
        r = await raw(method, path, body, token);
      }
      if (r.status >= 200 && r.status < 300) return r.data || {};
      return fail(toError(r));
    }

    async function login(username, password, apiBase) {
      if (apiBase) await store.set("local", { [K.base]: normalizeBase(apiBase) });
      const r = await raw("POST", "/auth/login", {
        username: String(username || "").trim(),
        password: String(password || ""),
        client: { kind: "extension", ext, deviceId: await deviceId(), deviceName: o.deviceName || "Browser", version: o.version },
      });
      if (r.status !== 200 || !r.data || !r.data.accessToken || !r.data.refreshToken) throw toError(r);
      await store.clear("session");
      await store.remove("local", [K.reason]);
      await store.set("local", { [K.refresh]: r.data.refreshToken });
      await store.set("session", { [K.user]: r.data.user || null });
      await saveAccess(r.data);
      return r.data;
    }

    /** Best-effort server sign-out, then local wipe. */
    async function logout() {
      try {
        const a = await getSession(K.access);
        if (a && a.token) await raw("POST", "/auth/logout", {}, a.token);
      } catch (_) {}
      await signOut("");
    }

    async function signedIn() {
      return !!(await getLocal(K.refresh));
    }

    return { login, logout, request, refresh, signOut, signedIn, base, deviceId, raw };
  }

  return { createClient, ApiError, friendly, normalizeBase, FATAL, KEYS: K };
});
