"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createClient, ApiError, normalizeBase } = require("../lib/api-core.js");

// In-memory stand-in for chrome.storage.local / chrome.storage.session.
function memStore() {
  const areas = { local: {}, session: {} };
  return {
    areas,
    async get(area, keys) {
      return Object.fromEntries(keys.filter((k) => k in areas[area]).map((k) => [k, areas[area][k]]));
    },
    async set(area, obj) {
      Object.assign(areas[area], JSON.parse(JSON.stringify(obj)));
    },
    async remove(area, keys) {
      keys.forEach((k) => delete areas[area][k]);
    },
    async clear(area) {
      areas[area] = {};
    },
  };
}

// fetch fake: routes "METHOD /path" → handler(req) → { status, body }; records every call.
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init) => {
    const path = url.replace(/^https?:\/\/[^/]+\/api\/v1/, "");
    const req = { url, path, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(req);
    const h = routes[init.method + " " + path.split("?")[0]];
    if (!h) return { status: 404, text: async () => JSON.stringify({ code: "not_found", message: "nope" }) };
    const r = await h(req, calls);
    if (r === "network") throw new TypeError("Failed to fetch");
    return { status: r.status, text: async () => (r.body === undefined ? "" : JSON.stringify(r.body)) };
  };
  fn.calls = calls;
  return fn;
}

const T0 = 1_700_000_000_000;
function client(routes, extra) {
  const store = memStore();
  const fetch = fakeFetch(routes);
  let t = T0;
  const signedOut = [];
  const api = createClient({
    fetch,
    store,
    version: "1.6.0",
    defaultBase: "http://localhost:4000",
    uuid: () => "dev-1",
    now: () => t,
    deviceName: "Chrome on test",
    onSignedOut: (r) => signedOut.push(r),
    ...extra,
  });
  return { api, store, fetch, signedOut, tick: (ms) => (t += ms) };
}

const loginOk = () => ({
  status: 200,
  body: { accessToken: "at1", accessExpiresAt: T0 + 600e3, refreshToken: "rt1", refreshExpiresAt: T0 + 30 * 86400e3, user: { id: "u1", username: "ali", role: "user" }, entitlements: [] },
});

test("login sends the client block, stores refresh in local and access in session", async () => {
  const c = client({ "POST /auth/login": loginOk });
  await c.api.login(" ali ", "secret", "https://hub.example.com/");
  const call = c.fetch.calls[0];
  assert.equal(call.url, "https://hub.example.com/api/v1/auth/login");
  assert.deepEqual(call.body, {
    username: "ali",
    password: "secret",
    client: { kind: "extension", ext: "citamate", deviceId: "dev-1", deviceName: "Chrome on test", version: "1.6.0" },
  });
  assert.equal(call.headers["X-Client"], "citamate/1.6.0");
  assert.equal(call.headers["X-Device-Id"], "dev-1");
  assert.equal(c.store.areas.local["cm.refresh"], "rt1");
  assert.equal(c.store.areas.local["cm.apiBase"], "https://hub.example.com");
  assert.equal(c.store.areas.session["cm.access"].token, "at1");
  assert.equal(c.store.areas.local["cm.access"], undefined, "access token never on disk");
  assert.equal(await c.api.signedIn(), true);
});

test("wrong password → invalid_credentials, nothing stored", async () => {
  const c = client({ "POST /auth/login": () => ({ status: 401, body: { code: "invalid_credentials", message: "x" } }) });
  await assert.rejects(c.api.login("ali", "bad"), (e) => e.code === "invalid_credentials" && /Wrong username/.test(e.message));
  assert.equal(c.store.areas.local["cm.refresh"], undefined);
});

test("request sends Bearer token and returns the JSON body", async () => {
  const c = client({ "POST /auth/login": loginOk, "GET /citamate/profiles": () => ({ status: 200, body: { items: [{ id: "p1" }] } }) });
  await c.api.login("ali", "pw");
  const r = await c.api.request("GET", "/citamate/profiles");
  assert.deepEqual(r, { items: [{ id: "p1" }] });
  assert.equal(c.fetch.calls[1].headers.Authorization, "Bearer at1");
});

test("access_token_expired → refresh once, retry once", async () => {
  let n = 0;
  const c = client({
    "POST /auth/login": loginOk,
    "POST /auth/refresh": (req) => {
      assert.deepEqual(req.body, { refreshToken: "rt1" });
      return { status: 200, body: { accessToken: "at2", accessExpiresAt: T0 + 1200e3, refreshExpiresAt: T0 + 9e9 } };
    },
    "GET /bootstrap": (req) => {
      n++;
      if (req.headers.Authorization === "Bearer at1") return { status: 401, body: { code: "access_token_expired" } };
      return { status: 200, body: { enabled: true } };
    },
  });
  await c.api.login("ali", "pw");
  const r = await c.api.request("GET", "/bootstrap?ext=citamate");
  assert.deepEqual(r, { enabled: true });
  assert.equal(n, 2);
  assert.equal(c.fetch.calls.filter((x) => x.path === "/auth/refresh").length, 1);
  assert.equal(c.store.areas.session["cm.access"].token, "at2");
});

test("a second access_token_expired after the retry is not retried again", async () => {
  const c = client({
    "POST /auth/login": loginOk,
    "POST /auth/refresh": () => ({ status: 200, body: { accessToken: "at2", accessExpiresAt: T0 + 1200e3 } }),
    "GET /x": () => ({ status: 401, body: { code: "access_token_expired" } }),
  });
  await c.api.login("ali", "pw");
  await assert.rejects(c.api.request("GET", "/x"), (e) => e.code === "access_token_expired");
  assert.equal(c.fetch.calls.filter((x) => x.path === "/x").length, 2);
});

test("an expired cached access token is refreshed before the call; concurrent calls share one refresh", async () => {
  const c = client({
    "POST /auth/login": loginOk,
    "POST /auth/refresh": () => ({ status: 200, body: { accessToken: "at2", accessExpiresAt: T0 + 2000e3 } }),
    "GET /a": () => ({ status: 200, body: { a: 1 } }),
  });
  await c.api.login("ali", "pw");
  c.tick(700e3); // past at1's expiry
  await Promise.all([c.api.request("GET", "/a"), c.api.request("GET", "/a"), c.api.request("GET", "/a")]);
  assert.equal(c.fetch.calls.filter((x) => x.path === "/auth/refresh").length, 1);
  assert.ok(c.fetch.calls.filter((x) => x.path === "/a").every((x) => x.headers.Authorization === "Bearer at2"));
});

for (const code of ["session_expired", "subscription_expired", "account_disabled", "device_revoked", "no_entitlement"]) {
  test(code + " wipes tokens + session cache and keeps the reason", async () => {
    const c = client({
      "POST /auth/login": loginOk,
      "GET /citamate/profiles": () => ({ status: code === "session_expired" ? 401 : 403, body: { code, message: "m", expiresAt: T0 } }),
    });
    await c.api.login("ali", "pw");
    await c.store.set("session", { "cm.entries": { t: 1, items: [{ id: "p" }] } });
    await assert.rejects(c.api.request("GET", "/citamate/profiles"), (e) => e.code === code);
    assert.equal(c.store.areas.local["cm.refresh"], undefined);
    assert.deepEqual(c.store.areas.session, {});
    assert.ok(c.store.areas.local["cm.signoutReason"].length > 5);
    assert.equal(c.signedOut.length, 1);
    if (code === "subscription_expired") assert.match(c.store.areas.local["cm.signoutReason"], /expired on/);
  });
}

test("refresh rejected with a plain 401 → treated as session_expired (signed out)", async () => {
  const c = client({
    "POST /auth/login": loginOk,
    "POST /auth/refresh": () => ({ status: 401, body: { code: "not_signed_in" } }),
    "GET /a": () => ({ status: 401, body: { code: "access_token_expired" } }),
  });
  await c.api.login("ali", "pw");
  await assert.rejects(c.api.request("GET", "/a"), (e) => ["session_expired", "not_signed_in"].includes(e.code));
  assert.equal(await c.api.signedIn(), false);
});

test("network failure → code network, still signed in", async () => {
  const c = client({ "POST /auth/login": loginOk, "GET /a": () => "network" });
  await c.api.login("ali", "pw");
  await assert.rejects(c.api.request("GET", "/a"), (e) => e instanceof ApiError && e.code === "network" && /Can't reach/.test(e.message));
  assert.equal(await c.api.signedIn(), true);
});

test("426 update_required → friendly message with the minimum version, not signed out", async () => {
  const c = client({ "POST /auth/login": loginOk, "GET /a": () => ({ status: 426, body: { code: "update_required", minVersion: "1.7.0" } }) });
  await c.api.login("ali", "pw");
  await assert.rejects(c.api.request("GET", "/a"), (e) => e.code === "update_required" && /1\.7\.0/.test(e.message));
  assert.equal(await c.api.signedIn(), true);
});

test("validation_error lists the fields", async () => {
  const c = client({ "POST /auth/login": loginOk, "POST /citamate/profiles": () => ({ status: 400, body: { code: "validation_error", fields: { label: "required" } } }) });
  await c.api.login("ali", "pw");
  await assert.rejects(c.api.request("POST", "/citamate/profiles", {}), (e) => /label: required/.test(e.message));
});

test("logout tells the server and wipes local state", async () => {
  const c = client({ "POST /auth/login": loginOk, "POST /auth/logout": () => ({ status: 200, body: { ok: true } }) });
  await c.api.login("ali", "pw");
  await c.api.logout();
  assert.ok(c.fetch.calls.some((x) => x.path === "/auth/logout" && x.headers.Authorization === "Bearer at1"));
  assert.equal(await c.api.signedIn(), false);
  assert.equal(c.store.areas.local["cm.deviceId"], "dev-1", "device id survives sign-out");
});

test("not signed in → request fails without calling the server", async () => {
  const c = client({});
  await assert.rejects(c.api.request("GET", "/a"), (e) => e.code === "not_signed_in");
  assert.equal(c.fetch.calls.length, 0);
});

test("normalizeBase", () => {
  assert.equal(normalizeBase("https://a.b/ "), "https://a.b");
  assert.equal(normalizeBase("http://localhost:4000///"), "http://localhost:4000");
  assert.throws(() => normalizeBase("ftp://x"), /https/);
  assert.throws(() => normalizeBase("not a url"), /Server address/);
});
