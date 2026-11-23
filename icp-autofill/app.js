// Entries page shell: sign-in gate, server data store and account bar.
// Everything goes through the service worker (background.js); this page never calls the API.
//
// window.CM = {
//   send(type, payload) → Promise<reply>   throws { code, message } on { ok: false }
//   ready                → Promise, resolves once signed in and the data + catalog are loaded
//   data                 → { entries, logs, sightings } (kept current from chrome.storage.session)
//   on(fn)               → fn(changedKeys) after data changes ("entries" | "logs" | "sightings")
//   status               → last CM_STATUS reply
// }
// The catalog is exposed as window.ICP_PROVINCES / ICP_PAISES / ICP_TRAMITES / ICP_OFFICES
// (the names the old bundled catalog.js used), so paste.js and the forms keep working.
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);

  async function send(type, payload) {
    let r;
    try {
      r = await chrome.runtime.sendMessage({ type, ...(payload || {}) });
    } catch (err) {
      throw { code: "extension", message: "CitaMate's background didn't answer – reload this page." };
    }
    if (!r) throw { code: "extension", message: "No answer from CitaMate – reload this page." };
    if (!r.ok) throw r.error || { code: "error", message: "CitaMate error" };
    return r;
  }

  let resolveReady;
  const ready = new Promise((r) => (resolveReady = r));
  const data = { entries: [], logs: [], sightings: [] };
  const listeners = new Set();
  const CM = { send, ready, data, status: null, on: (fn) => listeners.add(fn) };
  window.CM = CM;

  const emit = (keys) => listeners.forEach((fn) => {
    try {
      fn(keys);
    } catch (err) {
      console.error(err);
    }
  });

  // The worker keeps its cache in storage.session; mirror it here.
  const SESSION_KEYS = { "cm.entries": "entries", "cm.logs": "logs", "cm.sightings": "sightings" };
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session") {
      const keys = [];
      for (const [k, name] of Object.entries(SESSION_KEYS)) {
        if (!changes[k]) continue;
        const v = changes[k].newValue;
        data[name] = v && Array.isArray(v.items) ? v.items : [];
        keys.push(name);
      }
      if (keys.length) emit(keys);
    }
    // Signed in/out in another tab or forced out by the server → show the right screen.
    if (area === "local" && changes["cm.refresh"]) location.reload();
  });

  // ---------- views ----------
  function view(name) {
    $("authView").hidden = name !== "auth";
    $("stateView").hidden = name !== "state";
    $("appView").hidden = name !== "app";
    $("appBar").hidden = name !== "app";
  }

  function showState(text, retry) {
    $("stateText").textContent = text;
    $("stateRetry").hidden = !retry;
    view("state");
  }

  function showLogin(st) {
    $("loginServer").value = st.apiBase || st.defaultApiBase || "";
    $("loginError").textContent = st.reason || "";
    $("loginError").hidden = !st.reason;
    $("loginVersion").textContent = "CitaMate " + (st.version || "");
    view("auth");
    setTimeout(() => $("loginUser").focus(), 0);
  }

  const fmtDay = (t) => new Date(t).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });

  function renderAccount(st, boot) {
    const user = (boot && boot.user) || st.user || {};
    const ent = (boot && boot.entitlement) || st.entitlement;
    $("who").textContent = user.username || "";
    $("who").title = user.role === "admin" ? "Administrator" : "";
    let text = "";
    if (user.role === "admin" && !ent) text = "Admin";
    else if (ent && ent.expiresAt) {
      const days = Math.ceil((ent.expiresAt - Date.now()) / 86400e3);
      text = "Access until " + fmtDay(ent.expiresAt) + (days <= 7 ? " (" + Math.max(0, days) + " d left)" : "");
      $("expiry").classList.toggle("soon", days <= 7);
    } else if (ent) text = "Access: no expiry";
    $("expiry").textContent = text;
  }

  function renderMigration(m) {
    const box = $("migrateBanner");
    box.hidden = !m;
    if (!m) return;
    const parts = [];
    if (m.entries) parts.push(m.entries + " entr" + (m.entries === 1 ? "y" : "ies"));
    if (m.logs) parts.push(m.logs + " log record" + (m.logs === 1 ? "" : "s"));
    if (m.sightings) parts.push(m.sightings + " office check" + (m.sightings === 1 ? "" : "s"));
    $("migrateText").textContent =
      "This browser still has data from an older CitaMate version (" + parts.join(", ") + "). Entries are now added in the web panel: " +
      "download them, use Import JSON on the panel's Entries page, then remove them from this browser.";
    $("migrateDownload").hidden = !m.entries;
  }

  // ---------- sign in / out ----------
  $("loginForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const btn = $("loginSubmit");
    btn.disabled = true;
    btn.textContent = "Signing in…";
    $("loginError").hidden = true;
    try {
      await send("CM_LOGIN", { username: $("loginUser").value, password: $("loginPass").value, apiBase: $("loginServer").value });
      location.reload();
    } catch (err) {
      $("loginError").textContent = err.message || "Sign-in failed.";
      $("loginError").hidden = false;
      btn.disabled = false;
      btn.textContent = "Sign in";
    }
  });

  $("btnSignOut").addEventListener("click", async () => {
    $("btnSignOut").disabled = true;
    try {
      await send("CM_LOGOUT");
    } catch (_) {}
    location.reload();
  });

  $("stateRetry").addEventListener("click", () => start());

  // Old local data: entries go to the web panel (Import JSON); the extension can't add them.
  const panelUrl = () => String((CM.status && (CM.status.apiBase || CM.status.defaultApiBase)) || "").replace(/\/+$/, "") + "/app#entries";
  $("migrateOpen").addEventListener("click", () => window.open(panelUrl(), "_blank", "noopener"));
  $("migrateDownload").addEventListener("click", async () => {
    try {
      const r = await send("CM_LEGACY_EXPORT");
      const blob = new Blob([JSON.stringify(r.items || [], null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "citamate-old-entries.json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (err) {
      alert("Download failed: " + err.message);
    }
  });
  $("migrateDrop").addEventListener("click", async () => {
    if (!confirm("Remove the old entries and logs from this browser? Do this after importing them in the web panel.")) return;
    try {
      await send("CM_LEGACY_DROP");
      $("migrateBanner").hidden = true;
    } catch (err) {
      alert(err.message);
    }
  });


  // ---------- start ----------
  async function start() {
    showState("Loading…", false);
    let st;
    try {
      st = await send("CM_STATUS");
    } catch (err) {
      return showState(err.message, true);
    }
    CM.status = st;
    if (!st.signedIn) return showLogin(st);
    try {
      const r = await send("CM_GET_DATA", { what: ["entries", "logs", "sightings", "catalog"], fresh: true });
      const cat = r.catalog || {};
      window.ICP_PROVINCES = cat.provinces || [];
      window.ICP_PAISES = cat.paises || [];
      window.ICP_TRAMITES = cat.tramites || {};
      window.ICP_OFFICES = cat.offices || {};
      data.entries = r.entries || [];
      data.logs = r.logs || [];
      data.sightings = r.sightings || [];
      renderAccount(st, r.bootstrap);
      // Status is read before the data, so ask again for the migration counts.
      const st2 = await send("CM_STATUS").catch(() => st);
      renderMigration(st2.migration);
      view("app");
      resolveReady();
    } catch (err) {
      // Forced sign-out (expired, disabled…): the storage listener reloads into the sign-in form.
      showState(err.message || "Something went wrong.", err.code !== "update_required");
    }
  }

  start();
})();
