"use strict";
// Runs the real background.js in a VM with a fake `chrome` and a fake ext-hub server,
// to check the message flow end to end (sign-in, data, cache, outbox, migration, guards).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const SEEDS = path.join(ROOT, "..", "ext-hub", "seeds");

function area() {
  let data = {};
  const listeners = [];
  return {
    _dump: () => JSON.parse(JSON.stringify(data)),
    _listeners: listeners,
    async get(keys) {
      const ks = typeof keys === "string" ? [keys] : keys;
      return JSON.parse(JSON.stringify(Object.fromEntries(ks.filter((k) => k in data).map((k) => [k, data[k]]))));
    },
    async set(obj) {
      data = { ...data, ...JSON.parse(JSON.stringify(obj)) };
    },
    async remove(keys) {
      (typeof keys === "string" ? [keys] : keys).forEach((k) => delete data[k]);
    },
    async clear() {
      data = {};
    },
  };
}

// Minimal ext-hub: one user, profiles, logs, sightings, catalog, bootstrap.
function fakeServer() {
  const db = { profiles: [], logs: [], sightings: [], seq: 0 };
  const site = JSON.parse(fs.readFileSync(path.join(SEEDS, "citamate-site-config.json"), "utf8"));
  const catalog = JSON.parse(fs.readFileSync(path.join(SEEDS, "citamate-catalog.json"), "utf8"));
  const calls = [];
  const json = (status, body) => ({ status, text: async () => JSON.stringify(body) });
  const id = () => "srv-" + ++db.seq;
  async function fetch(url, init) {
    const u = new URL(url);
    const p = u.pathname.replace("/api/v1", "");
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method, path: p, body, headers: init.headers });
    if (p === "/auth/login") {
      if (body.password !== "pw") return json(401, { code: "invalid_credentials" });
      return json(200, { accessToken: "AT", accessExpiresAt: Date.now() + 600e3, refreshToken: "RT", user: { id: "u1", username: "ali", role: "user" }, entitlements: [] });
    }
    if (p === "/auth/logout") return json(200, { ok: true });
    if (init.headers.Authorization !== "Bearer AT") return json(401, { code: "not_signed_in" });
    const k = init.method + " " + p;
    if (k === "GET /bootstrap")
      return json(200, { user: { id: "u1", username: "ali", role: "user" }, entitlement: { ext: "citamate", expiresAt: Date.now() + 9e9, maxDevices: 2, active: true }, minVersion: "1.0.0", enabled: true, catalogVersion: 3, siteConfig: site, serverTime: Date.now() });
    if (k === "GET /citamate/catalog") return json(200, { version: 3, data: catalog });
    if (k === "GET /citamate/profiles") return json(200, { items: db.profiles });
    if (k === "POST /citamate/profiles") {
      const item = { ...body, id: id(), ownerId: "u1" };
      db.profiles.push(item);
      return json(201, { item });
    }
    if (k === "POST /citamate/profiles/bulk") {
      const items = body.items.map((b) => ({ ...b, id: id(), ownerId: "u1" }));
      db.profiles.push(...items);
      return json(201, { items });
    }
    if (init.method === "PUT" && p.startsWith("/citamate/profiles/")) {
      const i = db.profiles.findIndex((x) => x.id === p.split("/").pop());
      db.profiles[i] = { ...db.profiles[i], ...body };
      return json(200, { item: db.profiles[i] });
    }
    if (init.method === "DELETE" && p.startsWith("/citamate/profiles/")) {
      db.profiles = db.profiles.filter((x) => x.id !== p.split("/").pop());
      return json(200, { ok: true });
    }
    for (const [route, key] of [["/citamate/logs", "logs"], ["/citamate/office-sightings", "sightings"]]) {
      if (p !== route) continue;
      if (init.method === "GET") return json(200, { items: db[key] });
      if (init.method === "POST") {
        const ids = new Set(db[key].map((x) => x.id));
        const fresh = body.items.filter((x) => !ids.has(x.id));
        db[key].push(...fresh);
        return json(200, { saved: fresh.length });
      }
      if (init.method === "DELETE") {
        const n = db[key].length;
        db[key] = [];
        return json(200, { removed: n });
      }
    }
    return json(404, { code: "not_found" });
  }
  return { fetch, db, calls };
}

function loadBackground(server) {
  const local = area();
  const session = area();
  let onMessage = null;
  const chrome = {
    storage: { local, session },
    runtime: {
      getManifest: () => ({ version: "1.6.0" }),
      getURL: (p) => "chrome-extension://abc/" + p,
      onMessage: { addListener: (fn) => (onMessage = fn) },
      openOptionsPage: () => {},
    },
    action: { onClicked: { addListener: () => {} } },
    tabs: { create: () => {} },
  };
  const ctx = {
    chrome,
    fetch: server.fetch,
    navigator: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/130" },
    crypto: { randomUUID: () => "device-xyz" },
    URL,
    console,
    setTimeout,
    clearTimeout,
  };
  ctx.self = ctx;
  ctx.globalThis = ctx;
  ctx.importScripts = (...files) => files.forEach((f) => vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), ctx, { filename: f }));
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "background.js"), "utf8"), ctx, { filename: "background.js" });
  const PAGE = { url: "chrome-extension://abc/entries.html" };
  const SITE = { url: "https://icp.administracionelectronica.gob.es/icpplus/citar", tab: { id: 1 } };
  const send = (msg, sender = PAGE) =>
    new Promise((resolve) => {
      // JSON round-trip: replies are built in the VM's realm (and Chrome serialises them too).
      const async = onMessage(msg, sender, (r) => resolve(r === undefined ? r : JSON.parse(JSON.stringify(r))));
      if (async !== true) resolve(undefined);
    });
  return { send, local, session, PAGE, SITE };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

test("signed out: status says so, data is refused", async () => {
  const s = fakeServer();
  const bg = loadBackground(s);
  const st = await bg.send({ type: "CM_STATUS" });
  assert.equal(st.ok, true);
  assert.equal(st.signedIn, false);
  assert.equal(st.apiBase, "http://localhost:4000");
  const d = await bg.send({ type: "CM_GET_DATA", what: ["entries"] }, bg.SITE);
  assert.equal(d.ok, false);
  assert.equal(d.error.code, "not_signed_in");
  assert.equal(s.calls.length, 0);
});

test("wrong password → error, still signed out", async () => {
  const bg = loadBackground(fakeServer());
  const r = await bg.send({ type: "CM_LOGIN", username: "ali", password: "nope" });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "invalid_credentials");
});

test("full flow: login, data, read-only entries, content logs, clear, logout", async () => {
  const s = fakeServer();
  const bg = loadBackground(s);
  const st = await bg.send({ type: "CM_LOGIN", username: "ali", password: "pw", apiBase: "http://localhost:4000" });
  assert.equal(st.ok, true, JSON.stringify(st));
  assert.equal(st.signedIn, true);
  assert.equal(st.user.username, "ali");
  assert.ok(st.entitlement.expiresAt);
  assert.equal(bg.local._dump()["cm.refresh"], "RT");
  assert.ok(s.calls.find((c) => c.path === "/auth/login").headers["X-Device-Id"] === "device-xyz");

  const d = await bg.send({ type: "CM_GET_DATA", what: ["entries", "logs", "sightings", "catalog", "siteConfig"] });
  assert.equal(d.ok, true);
  assert.deepEqual(d.entries, []);
  assert.ok(d.catalog.provinces.length > 40);
  assert.ok(d.siteConfig.selectors);
  assert.equal(bg.session._dump()["cm.catalog"].version, 3);

  // Catalog is cached by version: a second call doesn't fetch it again.
  await bg.send({ type: "CM_GET_DATA", what: ["catalog"] });
  assert.equal(s.calls.filter((c) => c.path === "/citamate/catalog").length, 1);

  // Entries are managed in the web panel: no message can change them, from any sender.
  for (const type of ["CM_SAVE_ENTRY", "CM_SAVE_ENTRIES_BULK", "CM_DELETE_ENTRY", "CM_MIGRATE"]) {
    for (const sender of [undefined, bg.SITE]) {
      const r = await bg.send({ type, entry: { label: "x" }, items: [], id: "x" }, sender);
      assert.equal(r.ok, false, type);
    }
  }
  assert.ok(!s.calls.some((c) => c.path.startsWith("/citamate/profiles") && c.method !== "GET"), "no entry write reaches the server");
  // An entry added in the panel shows up after a fresh load.
  s.db.profiles.push({ id: "p1", label: "Ali", docNumber: "X1", fullName: "ALI" });
  const saved = { item: (await bg.send({ type: "CM_GET_DATA", what: ["entries"], fresh: true })).entries[0] };
  assert.equal(saved.item.label, "Ali");

  // Content script gets entries + config, and posts logs/sightings through the outbox.
  const cd = await bg.send({ type: "CM_GET_DATA", what: ["entries", "logs", "siteConfig"] }, bg.SITE);
  assert.equal(cd.ok, true);
  assert.equal(cd.entries.length, 1);
  const q = await bg.send({ type: "CM_ADD_LOGS", items: [{ id: "L1", t: 1, action: "Fill & Next", status: "ok", entryId: saved.item.id }] }, bg.SITE);
  assert.equal(q.queued, 1);
  await bg.send({ type: "CM_ADD_SIGHTINGS", items: [{ id: "S1", t: 1, offices: [] }] }, bg.SITE);
  await settle();
  assert.equal(s.db.logs.length, 1);
  assert.equal(s.db.sightings.length, 1);
  assert.deepEqual(bg.session._dump()["cm.outbox"], { logs: [], sightings: [] });
  assert.equal(bg.session._dump()["cm.logs"].items.length, 1);

  const cl = await bg.send({ type: "CM_CLEAR_LOGS" });
  assert.equal(cl.removed, 1);
  assert.equal(bg.session._dump()["cm.logs"].items.length, 0);

  await bg.send({ type: "CM_LOGOUT" });
  assert.equal(bg.local._dump()["cm.refresh"], undefined);
  assert.deepEqual(bg.session._dump(), {});
  assert.ok(s.calls.some((c) => c.path === "/auth/logout"));
});

test("old local data: entries exported for the web panel, then removed on request", async () => {
  const s = fakeServer();
  const bg = loadBackground(s);
  await bg.local.set({
    entries: [
      { id: "old1", label: "Ali", docNumber: "x1", fullName: "ali" },
      { id: "old2", label: "Sara", docNumber: "x2", fullName: "sara" },
    ],
    logs: [{ id: "l1", t: 1, entryId: "old2", entry: "Sara", status: "ok" }],
    officeSightings: [{ t: 2, entryId: "old1", entry: "Ali", offices: [] }],
    dialogUi: { side: "left" },
  });
  await bg.send({ type: "CM_LOGIN", username: "ali", password: "pw" });
  const st = await bg.send({ type: "CM_STATUS" });
  assert.deepEqual(st.migration, { entries: 2, logs: 1, sightings: 1 });

  const ex = await bg.send({ type: "CM_LEGACY_EXPORT" });
  assert.equal(ex.ok, true, JSON.stringify(ex));
  assert.deepEqual(ex.items.map((e) => e.label), ["Ali", "Sara"]);
  assert.ok(ex.items.every((e) => !("id" in e)), "ready for Import JSON (no old ids)");
  assert.equal(s.db.profiles.length, 0, "nothing uploaded by the extension");
  assert.ok(bg.local._dump().entries, "kept until the user removes it");

  const site = await bg.send({ type: "CM_LEGACY_DROP" }, bg.SITE);
  assert.equal(site.ok, false, "content scripts can't drop it");
  assert.equal((await bg.send({ type: "CM_LEGACY_DROP" })).ok, true);
  const left = bg.local._dump();
  assert.ok(!("entries" in left) && !("logs" in left) && !("officeSightings" in left));
  assert.deepEqual(left.dialogUi, { side: "left" }, "UI state untouched");
  assert.equal((await bg.send({ type: "CM_STATUS" })).migration, null);
});

test("server unreachable → network error, nothing cached", async () => {
  const s = fakeServer();
  const bg = loadBackground(s);
  await bg.send({ type: "CM_LOGIN", username: "ali", password: "pw" });
  const orig = s.fetch;
  // Swap to a failing network after sign-in.
  bg.session.clear();
  const bg2 = loadBackground({ fetch: async () => { throw new TypeError("Failed to fetch"); } });
  await bg2.local.set({ "cm.refresh": "RT" });
  const d = await bg2.send({ type: "CM_GET_DATA", what: ["entries"] }, bg2.SITE);
  assert.equal(d.ok, false);
  assert.equal(d.error.code, "network");
  assert.equal(bg2.local._dump()["cm.refresh"], "RT", "network trouble doesn't sign out");
  assert.ok(orig);
});
