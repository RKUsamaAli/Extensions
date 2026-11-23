// CitaMate service worker: the ONLY place that talks to the ext-hub server.
//
// Pages and the content script ask for data with chrome.runtime.sendMessage. We do not open
// chrome.storage.session to content scripts (setAccessLevel TRUSTED_AND_UNTRUSTED_CONTEXTS):
// the session area holds the access token, and content scripts run on a third-party site,
// so they only get the data they need through the messages below.
//
// Message set – request { type, ...payload } → reply { ok: true, ... } | { ok: false, error: { code, message, ... } }
//   From the entries page or the content script:
//     CM_STATUS                                → { signedIn, user, entitlement, apiBase, defaultApiBase, reason, migration }
//     CM_GET_DATA { what: string[], fresh? }   → { entries?, logs?, sightings?, catalog?, siteConfig?, bootstrap }
//                                               what ⊂ entries | logs | sightings | catalog | siteConfig
//     CM_ADD_LOGS { items }                    → { queued }   (content script batches; we post + retry)
//     CM_ADD_SIGHTINGS { items }               → { queued }
//     OPEN_ENTRIES { hash? }                   (no reply)
//   From extension pages only:
//     CM_LOGIN { username, password, apiBase } → status (as CM_STATUS)
//     CM_LOGOUT                                → {}
//     CM_SAVE_ENTRY { entry, id? }             → { item }   (id → PUT, else POST)
//     CM_SAVE_ENTRIES_BULK { items }           → { items }
//     CM_DELETE_ENTRY { id }                   → {}
//     CM_CLEAR_LOGS / CM_CLEAR_SIGHTINGS       → { removed }
//     CM_MIGRATE                               → { entries, logs, sightings }  (uploaded counts)
//
// Cache (chrome.storage.session, cleared on sign-out / browser close):
//   cm.boot {t, data}   cm.entries {t, items}   cm.logs {t, items}   cm.sightings {t, items}
//   cm.catalog {version, data}   cm.outbox {logs: [], sightings: []}
// Pages listen to storage.onChanged("session") on those keys to re-render.
importScripts("config.js", "lib/entry.js", "lib/api-core.js", "lib/migrate.js");

const CFG = self.CM_CONFIG;
const VERSION = chrome.runtime.getManifest().version;
const LOG_LIMIT = 5000;
const MAX_AGE = { boot: 5 * 60e3, entries: 30e3, logs: 60e3, sightings: 60e3 };
const PAGE_ONLY = new Set(["CM_LOGIN", "CM_LOGOUT", "CM_SAVE_ENTRY", "CM_SAVE_ENTRIES_BULK", "CM_DELETE_ENTRY", "CM_CLEAR_LOGS", "CM_CLEAR_SIGHTINGS", "CM_MIGRATE"]);

function deviceName() {
  const ua = navigator.userAgent || "";
  const os = /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "macOS" : /Android/.test(ua) ? "Android" : /CrOS/.test(ua) ? "ChromeOS" : /Linux/.test(ua) ? "Linux" : "unknown OS";
  const br = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Chrome\//.test(ua) ? "Chrome" : "Browser";
  return br + " on " + os;
}

const store = {
  get: (area, keys) => chrome.storage[area].get(keys),
  set: (area, obj) => chrome.storage[area].set(obj),
  remove: (area, keys) => chrome.storage[area].remove(keys),
  clear: (area) => chrome.storage[area].clear(),
};

const api = CM_API.createClient({
  fetch: (...a) => fetch(...a),
  store,
  version: VERSION,
  defaultBase: CFG.API_BASE,
  ext: CFG.EXT,
  deviceName: deviceName(),
});

const sget = async (key) => (await chrome.storage.session.get(key))[key];
const sset = (key, value) => chrome.storage.session.set({ [key]: value });
const fresh = (c, maxAge) => !!c && Date.now() - c.t < maxAge;
const byLabel = (a, b) => String(a.label || "").localeCompare(String(b.label || ""));

// ---------- bootstrap / catalog ----------
async function bootstrap(force) {
  const c = await sget("cm.boot");
  if (!force && fresh(c, MAX_AGE.boot)) return c.data;
  const data = await api.request("GET", "/bootstrap?ext=" + CFG.EXT);
  if (data.enabled === false) throw new CM_API.ApiError("ext_disabled", CM_API.friendly("ext_disabled"), 503);
  await sset("cm.boot", { t: Date.now(), data });
  if (data.user) await sset("cm.user", data.user);
  return data;
}

async function catalog(boot) {
  const c = await sget("cm.catalog");
  if (c && c.data && (boot.catalogVersion == null || c.version === boot.catalogVersion)) return c.data;
  const r = await api.request("GET", "/citamate/catalog");
  await sset("cm.catalog", { version: r.version, data: r.data });
  return r.data;
}

// ---------- lists ----------
async function list(key, path, maxAge, force) {
  const c = await sget(key);
  if (!force && fresh(c, maxAge)) return c.items;
  const r = await api.request("GET", path);
  const items = Array.isArray(r.items) ? r.items : [];
  await sset(key, { t: Date.now(), items });
  return items;
}
const entries = (force) => list("cm.entries", "/citamate/profiles", MAX_AGE.entries, force);
const logs = (force) => list("cm.logs", "/citamate/logs?limit=" + LOG_LIMIT, MAX_AGE.logs, force);
const sightings = (force) => list("cm.sightings", "/citamate/office-sightings?limit=" + LOG_LIMIT, MAX_AGE.sightings, force);

async function updateCache(key, fn) {
  const c = (await sget(key)) || { t: 0, items: [] };
  await sset(key, { t: c.t, items: fn(c.items || []) });
}

async function getData(what, force) {
  flushOutbox().catch(() => {});
  const boot = await bootstrap(force);
  const out = { bootstrap: boot };
  const jobs = [];
  if (what.includes("entries")) jobs.push(entries(force).then((v) => (out.entries = v)));
  if (what.includes("logs")) jobs.push(logs(force).then((v) => (out.logs = v)));
  if (what.includes("sightings")) jobs.push(sightings(force).then((v) => (out.sightings = v)));
  if (what.includes("catalog")) jobs.push(catalog(boot).then((v) => (out.catalog = v)));
  await Promise.all(jobs);
  if (what.includes("siteConfig")) out.siteConfig = boot.siteConfig || {};
  return out;
}

// ---------- outbox: logs + sightings from the content script ----------
let flushing = null;
async function queue(kind, items) {
  const clean = (Array.isArray(items) ? items : []).filter((x) => x && typeof x === "object").slice(0, 500);
  if (!clean.length) return 0;
  const box = (await sget("cm.outbox")) || { logs: [], sightings: [] };
  box[kind] = (box[kind] || []).concat(clean).slice(-LOG_LIMIT);
  await sset("cm.outbox", box);
  await updateCache(kind === "logs" ? "cm.logs" : "cm.sightings", (old) => {
    const seen = new Set(old.map((x) => x.id));
    return old.concat(clean.filter((x) => !seen.has(x.id))).slice(-LOG_LIMIT);
  });
  flushOutbox().catch(() => {});
  return clean.length;
}

function flushOutbox() {
  if (flushing) return flushing;
  flushing = (async () => {
    if (!(await api.signedIn())) return;
    for (const [kind, path] of [["logs", "/citamate/logs"], ["sightings", "/citamate/office-sightings"]]) {
      for (;;) {
        const box = (await sget("cm.outbox")) || { logs: [], sightings: [] };
        const batch = (box[kind] || []).slice(0, 500);
        if (!batch.length) break;
        await api.request("POST", path, { items: batch });
        const after = (await sget("cm.outbox")) || { logs: [], sightings: [] };
        const sent = new Set(batch.map((x) => x.id));
        after[kind] = (after[kind] || []).filter((x) => !sent.has(x.id));
        await sset("cm.outbox", after);
      }
    }
  })().finally(() => {
    flushing = null;
  });
  return flushing;
}

// ---------- entries ----------
async function saveEntry(entry, id) {
  const body = CM_ENTRY.body(entry || {});
  const r = id
    ? await api.request("PUT", "/citamate/profiles/" + encodeURIComponent(id), body)
    : await api.request("POST", "/citamate/profiles", body);
  await updateCache("cm.entries", (old) => old.filter((x) => x.id !== r.item.id).concat(r.item).sort(byLabel));
  return r.item;
}

async function saveBulk(items) {
  const created = [];
  for (const part of CM_MIGRATE.chunks((items || []).map((e) => CM_ENTRY.body(e)), 1000)) {
    const r = await api.request("POST", "/citamate/profiles/bulk", { items: part });
    created.push(...(r.items || []));
  }
  await updateCache("cm.entries", (old) => old.concat(created).sort(byLabel));
  return created;
}

async function deleteEntry(id) {
  await api.request("DELETE", "/citamate/profiles/" + encodeURIComponent(id));
  await updateCache("cm.entries", (old) => old.filter((x) => x.id !== id));
}

async function clearKind(kind) {
  await flushOutbox().catch(() => {});
  const path = kind === "logs" ? "/citamate/logs" : "/citamate/office-sightings";
  const r = await api.request("DELETE", path);
  const box = (await sget("cm.outbox")) || { logs: [], sightings: [] };
  box[kind] = [];
  await sset("cm.outbox", box);
  await sset(kind === "logs" ? "cm.logs" : "cm.sightings", { t: Date.now(), items: [] });
  return r.removed || 0;
}

// ---------- migration of pre-server local data ----------
async function migrationInfo() {
  const local = await chrome.storage.local.get(CM_MIGRATE.KEYS);
  const p = CM_MIGRATE.pending(local);
  // Empty leftovers: just tidy up.
  if (!p) {
    const present = CM_MIGRATE.KEYS.filter((k) => k in local);
    if (present.length) await chrome.storage.local.remove(present);
  }
  return p;
}

// Each stage removes its local key as soon as it is on the server, so a retry after a
// failure never uploads entries twice. The id map survives in cm.migration meanwhile.
async function migrate() {
  const local = await chrome.storage.local.get(CM_MIGRATE.KEYS.concat("cm.migration"));
  const state = local["cm.migration"] || { map: {}, labels: {} };
  const done = { entries: 0, logs: 0, sightings: 0 };
  const boot = await bootstrap(false);
  const cat = await catalog(boot);

  if (Array.isArray(local.entries) && local.entries.length) {
    const plan = CM_MIGRATE.planEntries(local.entries, cat.paises);
    const created = [];
    for (const part of CM_MIGRATE.chunks(plan.items, 1000)) {
      const r = await api.request("POST", "/citamate/profiles/bulk", { items: part });
      created.push(...(r.items || []));
    }
    state.map = { ...state.map, ...CM_MIGRATE.idMap(plan.oldIds, created) };
    created.forEach((c) => c.label && (state.labels[c.label] = c.id));
    done.entries = created.length;
    await chrome.storage.local.set({ "cm.migration": state });
  }
  await chrome.storage.local.remove("entries");

  for (const [key, kind, path] of [["logs", "logs", "/citamate/logs"], ["officeSightings", "sightings", "/citamate/office-sightings"]]) {
    const recs = CM_MIGRATE.remap(local[key], state.map, state.labels);
    for (const part of CM_MIGRATE.chunks(recs, 500)) {
      const r = await api.request("POST", path, { items: part });
      done[kind] += r.saved || 0;
    }
    await chrome.storage.local.remove(key);
  }
  await chrome.storage.local.remove("cm.migration");
  await Promise.all([entries(true), logs(true), sightings(true)]);
  return done;
}

// ---------- status ----------
async function status() {
  const local = await chrome.storage.local.get(["cm.signoutReason", "cm.apiBase"]);
  const signedIn = await api.signedIn();
  const out = {
    signedIn,
    apiBase: local["cm.apiBase"] || CFG.API_BASE,
    defaultApiBase: CFG.API_BASE,
    reason: local["cm.signoutReason"] || "",
    version: VERSION,
    user: null,
    entitlement: null,
    migration: null,
  };
  if (!signedIn) return out;
  const boot = await sget("cm.boot");
  out.user = (boot && boot.data && boot.data.user) || (await sget("cm.user")) || null;
  out.entitlement = (boot && boot.data && boot.data.entitlement) || null;
  out.migration = await migrationInfo();
  return out;
}

// ---------- messages ----------
const isPage = (sender) => !!(sender && sender.url && sender.url.startsWith(chrome.runtime.getURL("")));

async function handle(msg, sender) {
  if (PAGE_ONLY.has(msg.type) && !isPage(sender)) throw new CM_API.ApiError("forbidden", "Not allowed from a web page.");
  switch (msg.type) {
    case "CM_STATUS":
      return status();
    case "CM_LOGIN":
      await api.login(msg.username, msg.password, msg.apiBase);
      await bootstrap(true);
      return status();
    case "CM_LOGOUT":
      await flushOutbox().catch(() => {});
      await api.logout();
      return {};
    case "CM_GET_DATA":
      return getData(Array.isArray(msg.what) ? msg.what : [], !!msg.fresh);
    case "CM_ADD_LOGS":
      return { queued: await queue("logs", msg.items) };
    case "CM_ADD_SIGHTINGS":
      return { queued: await queue("sightings", msg.items) };
    case "CM_SAVE_ENTRY":
      return { item: await saveEntry(msg.entry, msg.id) };
    case "CM_SAVE_ENTRIES_BULK":
      return { items: await saveBulk(msg.items) };
    case "CM_DELETE_ENTRY":
      await deleteEntry(msg.id);
      return {};
    case "CM_CLEAR_LOGS":
      return { removed: await clearKind("logs") };
    case "CM_CLEAR_SIGHTINGS":
      return { removed: await clearKind("sightings") };
    case "CM_MIGRATE":
      return migrate();
    default:
      throw new CM_API.ApiError("bad_message", "Unknown message " + msg.type);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || typeof msg.type !== "string") return;
  if (msg.type === "OPEN_ENTRIES") {
    if (msg.hash) chrome.tabs.create({ url: chrome.runtime.getURL("entries.html#" + msg.hash) });
    else chrome.runtime.openOptionsPage();
    return;
  }
  if (!msg.type.startsWith("CM_")) return;
  handle(msg, sender).then(
    (r) => reply({ ok: true, ...r }),
    (err) =>
      reply({
        ok: false,
        error: err && err.toJSON ? err.toJSON() : { code: "error", message: String((err && err.message) || err) },
      }),
  );
  return true; // async reply
});

// Toolbar icon opens the entries page.
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
