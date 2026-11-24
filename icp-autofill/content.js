// CitaMate – floating button + dropdown on cita pages.
// "Fill & Next" fills the visible fields and presses the page's own Aceptar / Siguiente /
// Entrar / Solicitar Cita once – one page per click, never the captcha, slots or Confirmar.
// Every action and its outcome (moved / failed / stuck / done) is logged.
(() => {
  "use strict";
  if (window.__icpAutofill) return;
  window.__icpAutofill = true;

  // Entries, logs and the page settings (selectors/patterns, see ext-hub/seeds/citamate-site-config.json)
  // come from the CitaMate server through the service worker. Signed out, unreachable server or
  // no settings = "locked": the button only offers to open CitaMate and nothing is filled.
  // dialogUi (button position) and pendingNext (the Next press in flight) are local UI state.
  const UI_KEY = "dialogUi";
  const PENDING_KEY = "pendingNext";
  const MAX_LOGS = 1000;
  const STUCK_MS = 15000; // no page change this long after pressing Next = stuck
  const PENDING_MAX_AGE = 120000;
  const FLUSH_MS = 5000;

  let entries = [];
  let logs = [];
  let C = null; // hydrated site config (CM_SITE.hydrate)
  let locked = true;
  let lockReason = "Sign in to CitaMate to use it on this page.";
  let ui = { side: "right", top: 70, showLog: false, mode: null };
  // mode: null = booking, "check" = office check (stops at the office page), "checkDone" = check finished on this office page
  let lastAlert = "";
  let $status = () => ({});

  // Reply { ok, ...} from the service worker; throws { code, message } on failure.
  async function send(type, payload) {
    let r;
    try {
      r = await chrome.runtime.sendMessage({ type, ...(payload || {}) });
    } catch (_) {
      throw { code: "extension", message: "CitaMate was updated or reloaded – reload this page." };
    }
    if (!r) throw { code: "extension", message: "No answer from CitaMate – reload this page." };
    if (!r.ok) throw r.error || { code: "error", message: "CitaMate error" };
    return r;
  }

  // ---------- page helpers ----------
  const q = (sel) => document.querySelector(sel);
  const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().trim();
  const visible = (el) => !!(el && !el.disabled && el.type !== "hidden" && el.getClientRects().length);
  const bodyText = () => String((document.body && document.body.innerText) || document.body.textContent || "");

  function firstVisible(selectors) {
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) if (visible(el)) return el;
    }
    return null;
  }

  function setInput(el, value) {
    if (!visible(el) || value == null || value === "") return false;
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    el.focus();
    setter.call(el, String(value));
    ["input", "change", "keyup", "blur"].forEach((t) => el.dispatchEvent(new Event(t, { bubbles: true })));
    return true;
  }

  // Finds the option by saved value first, then by visible text.
  function findOption(sel, value, text) {
    if (!sel) return null;
    const opts = Array.from(sel.options || []).filter((o) => String(o.value || "").trim() !== "");
    const v = String(value || "").trim();
    const t = norm(text || value);
    if (v) {
      const byValue = opts.find((o) => o.value === v);
      if (byValue) return byValue;
    }
    if (!t) return null;
    return (
      opts.find((o) => norm(o.text) === t) ||
      opts.find((o) => norm(o.text).startsWith(t)) ||
      opts.find((o) => norm(o.text).includes(t)) ||
      null
    );
  }

  function setSelect(sel, value, text) {
    const hit = findOption(sel, value, text);
    if (!hit) return false;
    sel.value = hit.value;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    // The site draws this select with bootstrap-select; page-bridge.js refreshes it in the page world.
    document.dispatchEvent(new CustomEvent("icp-autofill:refresh-select", { detail: { id: sel.id, name: sel.name } }));
    return true;
  }

  function pickDocRadio(docType) {
    const want = norm(docType);
    const radios = Array.from(document.querySelectorAll('input[type="radio"]')).filter((r) => !r.disabled);
    const label = (r) => norm((r.labels && r.labels[0] && r.labels[0].textContent) || "");
    const noDots = (s) => s.replace(/\./g, "");
    const hay = (r) => noDots(norm(r.value) + " " + norm(r.id) + " " + label(r));
    const docRadios = radios.filter((r) => /\b(NIE|DNI|PASAPORTE|PASSPORT|PASAPORT\w*)\b|TIPO|DOC/.test(hay(r) + " " + norm(r.name)));
    let hit = radios.find((r) => noDots(norm(r.value)) === want);
    if (!hit && want === "PASAPORTE") hit = radios.find((r) => /PASAPORT|PASSPORT/.test(hay(r)));
    if (!hit && want !== "PASAPORTE") hit = radios.find((r) => new RegExp("\\b" + want + "\\b").test(hay(r)));
    if (hit) {
      if (!hit.checked) hit.click();
      return { ok: true };
    }
    // No document-type choice on this page: nothing to do.
    if (!docRadios.length) return { ok: true, skip: true };
    // The trámite offers a single type (e.g. only NIE): use it and carry on.
    if (docRadios.length === 1) {
      if (!docRadios[0].checked) docRadios[0].click();
      return { ok: true, note: "page only offers " + noDots(label(docRadios[0]) || norm(docRadios[0].value)) };
    }
    return { ok: false };
  }

  // All selectors / patterns below come from the server's site config (C).
  const provinceSelect = () =>
    q(C.selectors.provinceSelect) ||
    Array.from(document.querySelectorAll("select")).find((s) => C.patterns.provinceName.test(s.id + s.name));
  const tramiteSelects = () =>
    Array.from(document.querySelectorAll("select")).filter(
      (s) => C.patterns.tramiteName.test(s.id + s.name) && !C.patterns.tramiteExclude.test(s.id || s.name),
    );

  // Info / step pages with nothing to fill: acInfo "Entrar" and acValidarEntrada "Solicitar Cita".
  // Text is matched in Spanish and English because Chrome Translate rewrites it (C.stepButtons).
  const btnText = (b) => norm(b.value || b.textContent || "").replace(/\s+/g, " ");
  function stepButton(kind) {
    const spec = C.stepButtons[kind];
    if (!spec) return null;
    const byId = firstVisible(spec.ids);
    if (byId) return byId;
    const all = document.querySelectorAll(C.selectors.stepButtonCandidates);
    for (const b of all) if (visible(b) && spec.text.test(btnText(b))) return b;
    // e.g. acValidarEntrada uses #btnEnviar for "Solicitar Cita".
    if (spec.fallback && spec.fallback.path.test(location.pathname)) return firstVisible(spec.fallback.ids);
    return null;
  }

  // ---------- page + site message detection ----------
  // ICP flow addresses: citar → acInfo → acEntrada → acValidarEntrada → acCitar → acVerFormulario → acOfertarCita → acVerificarCita → acGrabarCita
  function pageType() {
    if (!C) return "";
    for (const p of C.urlPages) if (p.pattern.test(location.pathname)) return p.page;
    const txt = norm(bodyText());
    if (C.patterns.bookedText.test(txt)) return "Booked";
    if (q(C.selectors.confirm)) return "Confirm";
    if (q(C.selectors.office)) return "Office";
    if (q(C.selectors.docBox.join(", "))) return "Personal data";
    if (firstVisible(C.selectors.phone)) return "Contact";
    if (q(C.selectors.slots)) return "Slots";
    if (tramiteSelects().length) return "Trámite";
    if (provinceSelect()) return "Province";
    if (stepButton("Access")) return "Access";
    if (stepButton("Request")) return "Request";
    return "Other";
  }

  // Returns { known: bool, text } for the most useful site message on screen.
  function siteMessage() {
    const txt = norm(bodyText());
    for (const m of C.knownMessages) if (m.pattern.test(txt)) return { known: true, text: m.label };
    const box = firstVisible(C.selectors.messageBoxes);
    const t = box ? String(box.innerText || box.textContent || "").replace(/\s+/g, " ").trim() : "";
    return { known: false, text: t.slice(0, 220) };
  }

  // ---------- server outbox (logs + office sightings) ----------
  // Handed to the service worker as soon as they are made (see scheduleFlush); the worker
  // stores them, posts them in batches and retries.
  const outbox = { logs: [], sightings: [] };
  let flushTimer = 0;
  // Hand records to the worker right away (records made in the same moment go together):
  // the worker keeps them in storage and retries, so a Next press that navigates away, or a
  // closed tab, can't lose them. FLUSH_MS is only the retry delay when the worker is away.
  let flushQueued = false;
  function scheduleFlush(retry) {
    if (retry) {
      if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
      return;
    }
    if (flushQueued) return;
    flushQueued = true;
    queueMicrotask(() => {
      flushQueued = false;
      flush();
    });
  }
  function flush() {
    clearTimeout(flushTimer);
    flushTimer = 0;
    for (const [kind, type] of [["logs", "CM_ADD_LOGS"], ["sightings", "CM_ADD_SIGHTINGS"]]) {
      if (!outbox[kind].length) continue;
      const items = outbox[kind].splice(0, 500);
      send(type, { items }).catch((err) => {
        // Worker unreachable (extension reloading): keep them for the next try.
        if (err && err.code === "extension") {
          outbox[kind].unshift(...items);
          scheduleFlush(true);
        }
      });
      if (outbox[kind].length) scheduleFlush();
    }
  }
  addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && flush());
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  // ---------- logging ----------
  function addLog(rec) {
    const { fill, ...fields } = rec;
    const item = {
      id: newId(),
      t: Date.now(),
      page: rec.page || pageType(),
      url: location.pathname + location.search,
      kind: ui.mode === "check" || ui.mode === "checkDone" ? "check" : "booking",
      ...fields,
    };
    // Failed / stuck steps carry a snapshot of the page (fields, buttons, selectors tried,
    // site message – never typed values) so the panel can export them to fix the site config.
    if ((item.status === "fail" || item.status === "stuck") && window.CM_SNAPSHOT) {
      try {
        item.context = window.CM_SNAPSHOT.take({ C, page: item.page, message: siteMessage().text, alert: lastAlert, fill });
      } catch (_) {
        /* never let a snapshot problem stop the log */
      }
    }
    // Link the record to the entry by id so reports survive label changes.
    if (!item.entryId && item.entry) {
      const hit = entries.find((x) => x.label === item.entry);
      if (hit) item.entryId = hit.id;
    }
    logs.push(item);
    if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
    outbox.logs.push(item);
    scheduleFlush();
    renderLog();
    return item;
  }

  const setPending = (p) => chrome.storage.local.set({ [PENDING_KEY]: p });
  const clearPending = () => chrome.storage.local.remove(PENDING_KEY);

  // Site alert() popups are relayed by page-bridge.js.
  document.addEventListener("citamate:alert", (ev) => {
    lastAlert = String((ev.detail && ev.detail.message) || "").slice(0, 220);
    if (!lastAlert || locked) return;
    const e = entries.find((x) => x.id === ui.lastId);
    clearPending(); // the alert is the outcome of the last Next press
    addLog({ entry: e ? e.label : "", action: "Site alert", status: "fail", detail: lastAlert });
    show("fail", "Site says: " + lastAlert);
  });

  // ---------- filling ----------
  function fillEntry(e) {
    const done = [];
    const missing = [];
    const track = (name, ok, hasValue) => {
      if (!hasValue) return;
      (ok ? done : missing).push(name);
    };

    // Personal data page
    const docBox = firstVisible(C.selectors.docBox);
    if (docBox) {
      const doc = pickDocRadio(e.docType);
      if (!doc.skip) {
        if (doc.note) done.push("Doc type (" + doc.note + ")");
        else track("Doc type", doc.ok, !!e.docType);
      }
      track("Document", setInput(docBox, e.docNumber), !!e.docNumber);
      track("Name", setInput(firstVisible(C.selectors.name), e.fullName), !!e.fullName);
      // The year box can appear only after choosing Pasaporte, so retry shortly.
      const fillYear = () => setInput(firstVisible(C.selectors.birthYear), e.birthYear);
      if (e.birthYear) {
        if (fillYear()) done.push("Year");
        else setTimeout(() => fillYear() && ($status().textContent += " Year filled."), 600);
      }
      const pais = q(C.selectors.nationality);
      if (pais) track("Nationality", setSelect(pais, e.nationality, e.nationalityText), !!e.nationality);
    }

    // Province page
    const prov = provinceSelect();
    if (prov && e.province) track("Province", setSelect(prov, e.province, e.provinceText), true);

    // Trámite page (there can be several trámite selects; use the one that has it)
    const tramSels = tramiteSelects();
    if (tramSels.length && e.tramite) {
      const target = tramSels.find((s) => findOption(s, e.tramite, e.tramiteText));
      track("Trámite", !!target && setSelect(target, e.tramite, e.tramiteText), true);
    }

    // Office list – on the office page, and on some provinces' trámite page too. The site
    // won't continue without a real office, so "Any office" picks the first one listed.
    const office = q(C.selectors.office);
    if (office && e.office) track("Office", setSelect(office, e.office, e.officeText), true);
    else if (office && shownSelect(office) && !realOfficeSelected(office) && ui.mode !== "check" && ui.mode !== "checkDone") {
      const first = (readOffices() || [])[0];
      if (first && setSelect(office, first.value, first.text)) done.push("Office (any → " + first.text.split(",")[0].trim() + ")");
      else missing.push("Office");
    }

    // Contact page
    if (C.selectors.phone.map((s) => setInput(firstVisible([s]), e.phone)).some(Boolean)) done.push("Phone");
    if (C.selectors.email.map((s) => setInput(firstVisible([s]), e.email)).some(Boolean)) done.push("Email");

    return { done, missing };
  }

  function describe(r) {
    if (!r.done.length && !r.missing.length) return "No matching fields on this page.";
    let msg = r.done.length ? "Filled: " + r.done.join(", ") + "." : "";
    if (r.missing.length) msg += (msg ? " " : "") + "Not found: " + r.missing.join(", ") + ".";
    return msg;
  }

  // ---------- next button ----------
  // Next buttons: C.selectors.next. Info / step pages with nothing to fill (e.g. acInfo
  // "Entrar", "Solicitar Cita") are the keys of C.stepButtons.

  // A captcha the user still has to solve: reCAPTCHA/hCaptcha widget with an
  // empty response, or a visible image-captcha text box that is empty.
  function captchaPending() {
    const widget = q(C.selectors.captchaWidget);
    if (widget && widget.getClientRects().length) {
      const resp = q(C.selectors.captchaResponse);
      if (!resp || !String(resp.value || "").trim()) return true;
    }
    const imgBox = firstVisible(C.selectors.captchaImageBox);
    return !!(imgBox && !String(imgBox.value || "").trim());
  }

  // The mode lives in this tab's sessionStorage: it follows the booking flow from page to
  // page (every Aceptar loads a new page) but never leaks into other tabs or a new session.
  const MODE_KEY = "citamate:mode";
  function setMode(m) {
    if (ui.mode === m) return;
    ui.mode = m;
    try {
      if (m) sessionStorage.setItem(MODE_KEY, m);
      else sessionStorage.removeItem(MODE_KEY);
    } catch (_) { /* storage blocked: the mode lasts for this page only */ }
    saveUi();
    applyUi();
  }

  function doFillAndNext(e) {
    const checking = ui.mode === "check" || ui.mode === "checkDone";
    const actionName = checking ? "Office check" : "Fill & Next";
    if (checking && pageType() === "Office") {
      // Office check never selects an office or continues past this page.
      setMode("checkDone");
      addLog({ entry: e.label, action: actionName, status: "info", detail: "Stopped at the office page (check only)." });
      return show("info", "Office check finished – nothing was selected. Leave the page, or press the Fill & Next button to book.");
    }
    const r = fillEntry(e);
    const msg = describe(r);
    const stop = (status, why) => {
      addLog({ entry: e.label, action: actionName, status, detail: msg + " " + why, fill: r });
      show(status, e.label + ": " + msg + " " + why);
    };
    const from = pageType();
    let btn = null;
    if (!r.done.length && !r.missing.length) {
      // Nothing to fill: only continue on known info/step pages.
      btn = C.stepButtons[from] ? stepButton(from) : null;
      if (!btn) return stop("info", "Nothing to fill on this " + from + " page, so it wasn't pressed – continue yourself.");
    } else {
      if (!r.done.length) return stop("info", "Nothing filled, so Next was not pressed.");
      if (r.missing.length) return stop("fail", "Fix the missing fields, then press the page's button.");
    }
    if (captchaPending()) return stop("wait", "Waiting for you to solve the captcha.");
    btn = btn || firstVisible(C.selectors.next);
    if (!btn) return stop("fail", "No Aceptar/Siguiente button found on this page.");

    const label = String(btn.value || btn.textContent || "Next").trim();
    const at = Date.now();
    const did = r.done.length ? msg + " " : "";
    addLog({ entry: e.label, action: actionName, status: "ok", detail: did + "Pressed " + label + "." });
    show("run", e.label + ": " + did + "Pressing " + label + "…");
    lastAlert = "";
    setPending({ at, from, entry: e.label, entryId: e.id, button: label }).then(() => {
      // Short pause so the page's own change handlers finish before submitting.
      setTimeout(() => btn.click(), 400);
    });

    // If this page is still here after STUCK_MS, the click didn't lead anywhere.
    setTimeout(async () => {
      const got = await chrome.storage.local.get(PENDING_KEY);
      const p = got[PENDING_KEY];
      if (!p || p.at !== at) return;
      await clearPending();
      const sm = siteMessage();
      const why = lastAlert || sm.text || "no message from the site";
      addLog({ entry: e.label, action: "Result", status: "stuck", detail: "Still on " + from + " " + STUCK_MS / 1000 + "s after pressing " + label + " – " + why });
      show("stuck", "Stuck on " + from + ": " + why);
    }, STUCK_MS);
  }

  // ---------- automatic office check ----------
  // In office-check mode CitaMate presses Fill & Next by itself on every page up to the office
  // list, one page at a time with a short pause. It never solves the captcha: on that page it
  // fills the details and waits; once the person has ticked the reCAPTCHA it continues
  // (an image captcha: they type it and press Alt+Enter). Any error or "stuck" stops it.
  const AUTO_KEY = "citamate:auto";
  const AUTO_MAX = 10; // pages per check: the flow has 5–6, more means something loops
  const AUTO_DELAY = 1200;
  const AUTO_PAGES = ["Province", "Trámite", "Access", "Personal data", "Request"];
  let autoTimer = 0;
  let captchaTimer = 0;
  function autoCount(n) {
    try {
      if (n === undefined) return Number(sessionStorage.getItem(AUTO_KEY)) || 0;
      sessionStorage.setItem(AUTO_KEY, String(n));
    } catch (_) { /* storage blocked */ }
    return 0;
  }
  function stopAuto() {
    clearTimeout(autoTimer);
    clearInterval(captchaTimer);
    autoTimer = captchaTimer = 0;
  }
  function autoStep() {
    stopAuto();
    const e = current();
    if (ui.mode !== "check" || locked || !e) return;
    if (lastStatus === "fail" || lastStatus === "stuck") return; // a problem: the person decides
    if (!AUTO_PAGES.includes(pageType())) return;
    if (autoCount() >= AUTO_MAX) return show("info", "Office check paused after " + AUTO_MAX + " pages – press Alt+Enter to continue.");
    show("run", "Office check: continuing by itself…");
    autoTimer = setTimeout(() => {
      autoTimer = 0;
      if (ui.mode !== "check") return;
      if (!captchaPending()) {
        autoCount(autoCount() + 1);
        return doFillAndNext(e);
      }
      doFillAndNext(e); // fills the details, then waits for the captcha
      if (!q(C.selectors.captchaWidget)) return show("wait", "Type the captcha, then press Alt+Enter – CitaMate continues from there.");
      beep();
      show("wait", "Solve the captcha – CitaMate continues by itself when it's done.");
      captchaTimer = setInterval(() => {
        if (ui.mode !== "check") return stopAuto();
        if (captchaPending()) return;
        stopAuto();
        autoCount(autoCount() + 1);
        setTimeout(() => doFillAndNext(e), 500);
      }, 700);
    }, AUTO_DELAY);
  }

  // ---------- office availability ----------
  // The office page only lists offices that currently have appointments.
  // CitaMate reads that list whenever you reach the page and keeps a history.
  function readOffices() {
    const sel = q(C.selectors.office);
    if (!sel) return null;
    return Array.from(sel.options || [])
      .filter((o) => {
        const v = String(o.value || "").trim();
        const t = norm(o.text);
        return v && !C.officeExcludeValues.includes(v) && !C.patterns.officePlaceholder.test(t);
      })
      .map((o) => ({ value: o.value, text: String(o.text || "").replace(/\s+/g, " ").trim() }));
  }

  /** The site draws selects with bootstrap-select, which hides the real <select>: the
   *  widget next to it being visible counts as visible too. */
  function shownSelect(sel) {
    if (sel.getClientRects().length) return true;
    const widget = sel.closest(".bootstrap-select") || (sel.nextElementSibling && sel.nextElementSibling.matches(".bootstrap-select, .dropdown-toggle, button") ? sel.nextElementSibling : null);
    return !!(widget && widget.getClientRects().length);
  }

  function realOfficeSelected(sel) {
    const o = sel.options && sel.options[sel.selectedIndex];
    if (!o) return false;
    const v = String(o.value || "").trim();
    return !!v && !C.officeExcludeValues.includes(v) && !C.patterns.officePlaceholder.test(norm(o.text));
  }

  function beep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      [0, 0.25].forEach((d) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.frequency.value = 880;
        g.gain.value = 0.15;
        o.connect(g).connect(ctx.destination);
        o.start(ctx.currentTime + d);
        o.stop(ctx.currentTime + d + 0.15);
      });
    } catch (_) {}
  }

  async function recordOffices() {
    if (locked || !q(C.selectors.office)) return;
    // The list can be filled in by the site a moment after load: wait up to 5s.
    let offices = readOffices();
    for (let i = 0; i < 25 && offices && !offices.length; i++) {
      await new Promise((r) => setTimeout(r, 200));
      offices = readOffices();
    }
    if (!offices) return;
    const e = entries.find((x) => x.id === ui.lastId);
    const page = pageType();
    const sighting = {
      id: newId(),
      t: Date.now(),
      page, // only the real office page counts as availability (some trámite pages list every office)
      entry: e ? e.label : "",
      entryId: e ? e.id : "",
      province: (e && e.provinceText) || "",
      tramite: (e && e.tramiteText) || "",
      kind: ui.mode === "check" ? "check" : "booking",
      offices,
    };
    outbox.sightings.push(sighting);
    scheduleFlush();

    if (page !== "Office") return; // an office list on another page: kept, but no result yet
    renderOffices(offices, e);
    const checking = ui.mode === "check";
    const act = checking ? "Office check" : "Offices";
    const tail = checking ? " Office check finished – nothing selected, you can leave this page." : "";
    if (checking) setMode("checkDone");
    const names = offices.map((o) => o.text.split(",")[0]).join("; ");
    if (!offices.length) {
      addLog({ entry: sighting.entry, action: act, status: "info", page: "Office", detail: "No offices listed right now." });
      return show("info", "No offices listed right now." + tail);
    }
    const mine = e && e.office ? offices.find((o) => o.value === e.office || norm(o.text) === norm(e.officeText)) : null;
    if (mine) {
      beep();
      addLog({ entry: sighting.entry, action: act, status: "ok", page: "Office", detail: "Your office is available: " + mine.text + ". All " + offices.length + ": " + names });
      return show("ok", "Your office is available: " + mine.text.split(",")[0] + "." + tail);
    }
    const note = e && e.office ? "Your office isn't listed. " : "";
    addLog({ entry: sighting.entry, action: act, status: "ok", page: "Office", detail: note + offices.length + " available: " + names });
    show("info", note + offices.length + (offices.length === 1 ? " office" : " offices") + " available – see the list below." + tail);
  }

  function renderOffices(offices, e) {
    const box = $("offices");
    box.textContent = "";
    box.hidden = false;
    const h = document.createElement("div");
    h.className = "offh";
    h.textContent = "Offices available now (" + offices.length + ")";
    box.appendChild(h);
    offices.forEach((o) => {
      const d = document.createElement("div");
      d.className = "off";
      const parts = o.text.split(",");
      const b = document.createElement("b");
      b.textContent = parts[0];
      const s = document.createElement("span");
      s.textContent = parts.slice(1).join(",").trim();
      d.append(b, s);
      if (e && (o.value === e.office || norm(o.text) === norm(e.officeText))) d.classList.add("mine");
      box.appendChild(d);
    });
  }

  // Runs once per page load: resolves the previous Fill & Next, and notices
  // final/booked pages and known site errors.
  async function checkOnLoad() {
    if (ui.mode === "checkDone" && pageType() !== "Office") setMode(null);
    const page = pageType();
    const sm = siteMessage();
    const got = await chrome.storage.local.get(PENDING_KEY);
    const p = got[PENDING_KEY];
    if (p && Date.now() - p.at < PENDING_MAX_AGE) {
      await clearPending();
      const secs = ((Date.now() - p.at) / 1000).toFixed(1);
      if (page === "Booked") {
        addLog({ entry: p.entry, action: "Result", status: "done", page, detail: "Appointment booked (" + secs + "s)." });
        return show("done", p.entry + ": appointment booked.");
      }
      if (sm.known) {
        addLog({ entry: p.entry, action: "Result", status: "fail", page, detail: p.from + " → " + page + ": " + sm.text });
        return show("fail", p.entry + ": " + sm.text);
      }
      if (page === p.from) {
        const why = sm.text || "page reloaded with no message (likely a validation error)";
        addLog({ entry: p.entry, action: "Result", status: "fail", page, detail: "Back on " + page + " after " + p.button + " – " + why });
        return show("fail", p.entry + ": back on " + page + " – " + why);
      }
      addLog({ entry: p.entry, action: "Result", status: "ok", page, detail: "Moved " + p.from + " → " + page + " (" + secs + "s)." });
      return show("ok", p.entry + ": moved to " + page + ". Ready for the next step.");
    }
    if (p) await clearPending(); // too old to belong to this page
    const e = entries.find((x) => x.id === ui.lastId);
    const who = e ? e.label : "";
    const seenKey = "citamate:seen:" + location.pathname + location.search;
    if (page === "Booked" && !sessionStorage.getItem(seenKey)) {
      sessionStorage.setItem(seenKey, "1");
      addLog({ entry: who, action: "Page", status: "done", page, detail: "Booking confirmation page shown." });
      return show("done", "Appointment booked.");
    }
    if (sm.known) {
      addLog({ entry: who, action: "Page", status: "fail", page, detail: sm.text });
      return show("fail", sm.text);
    }
  }

  // ---------- floating button + dropdown ----------
  // A draggable round button on the page edge (like RelaySwitch). Clicking it opens
  // a dropdown: pick an entry, then Fill / Check office / Fill & Next.
  const APP = "CitaMate";
  const ICON = `<svg viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <defs>
      <linearGradient id="cm-bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1e3a8a"/><stop offset="1" stop-color="#0d9488"/></linearGradient>
      <linearGradient id="cm-check" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fdba74"/><stop offset="1" stop-color="#ea580c"/></linearGradient>
    </defs>
    <rect x="4" y="4" width="120" height="120" rx="30" fill="url(#cm-bg)"/>
    <path d="M88 38a34 34 0 1 0 6 40" fill="none" stroke="#fff" stroke-width="15" stroke-linecap="round"/>
    <path d="M54 64l11 11 26-27" fill="none" stroke="url(#cm-check)" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="88" cy="38" r="7.5" fill="#fff"/>
  </svg>`;

  const svg = (d, w = 2) => `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const IC = {
    check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>', 3),
    report: svg('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'),
    records: svg('<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/>'),
    manage: svg('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"/><path d="M17 8h5M19.5 5.5v5"/>'),
    activity: svg('<path d="M3 12h4l3-8 4 16 3-8h4"/>'),
  };

  const host = document.createElement("citamate-fab");
  host.id = "icp-autofill-host";
  // The shadow root is closed, so tests read the state from the host: data-state = locked | ready.
  host.setAttribute("data-testid", "citamate-fab");
  host.setAttribute("data-state", "locked");
  host.style.cssText = "all: initial; position: fixed; z-index: 2147483646;";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `<style>${CSS()}</style>
    <button class="fab" id="fab" data-testid="citamate-fab-button" aria-label="${APP}" aria-haspopup="menu" aria-expanded="false">${ICON}<span class="dot" id="fabDot"></span></button>
    <button class="quick" id="quick" hidden title="Fill &amp; Next with the selected entry (Alt+Enter)" aria-label="Fill and Next">${IC.check}</button>
    <div class="toast" id="toast" hidden><i class="sdot"></i><span id="toastText"></span></div>
    <div class="menu" id="menu" role="menu" hidden>
      <div class="head">
        <span class="logo">${ICON}</span><strong>${APP}</strong>
        <span class="chip" id="pageChip" title="Page CitaMate detected"></span>
        <button class="x" id="closeBtn" aria-label="Close">✕</button>
      </div>
      <div class="lockbox" id="lockbox" hidden>
        <b>Sign in to CitaMate</b>
        <span id="lockText"></span>
        <button class="btn primary" id="lockOpen" data-testid="citamate-open-signin">Open CitaMate</button>
        <button class="btn ghost" id="lockRetry">Try again</button>
      </div>
      <div class="modebar" id="modebar" hidden><span id="modeText"></span><button id="modeCancel">Cancel</button></div>

      <div class="section">
        <div class="lbl">Entry</div>
        <button class="picker" id="picker" aria-haspopup="listbox" aria-expanded="false">
          <span class="av" id="pickAv">?</span>
          <span class="pk"><b id="pickName">Choose an entry</b><small id="pickSub">Saved in Manage entries</small></span>
          <span class="chev">▾</span>
        </button>
        <div class="list" id="listWrap" hidden>
          <input class="search" id="search" type="search" placeholder="Search entries…" aria-label="Search entries">
          <div id="list" role="listbox"></div>
          <div class="nomatch" id="nomatch" hidden>No matching entries</div>
        </div>
      </div>

      <div class="acts">
        <button class="btn primary" id="actNext" title="Fill this page and press its Aceptar / Siguiente / Entrar / Solicitar Cita (Alt+Enter)">${IC.check}<span>Fill &amp; Next</span><span class="k">Alt+Enter</span></button>
        <button class="btn ghost" id="actCheck" title="Go through the pages up to the office list by itself, without booking, and share which offices are open (you solve the captcha)">Check offices</button>
      </div>

      <div class="status" id="foot"><i class="sdot"></i><span id="status">Pick an entry, then press Fill &amp; Next on each page.</span></div>
      <div class="offices" id="offices" hidden></div>

      <button class="fold" id="logBtn" aria-expanded="false">${IC.activity}<span>Recent activity</span><span class="cnt" id="logCnt"></span><span class="chev">▾</span></button>
      <div class="log" id="log" hidden><div id="logList"></div></div>

      <div class="foot">
        <a id="openReport" title="Entry report">${IC.report}<span>Report</span></a>
        <a id="openRecords" title="All records">${IC.records}<span>Records</span></a>
        <a id="manage" title="Manage entries">${IC.manage}<span>Entries</span></a>
      </div>
    </div>`;

  const $ = (id) => root.getElementById(id);
  $status = () => $("status");
  const menu = $("menu");
  const fab = $("fab");
  let toastTimer = 0;

  const current = () => entries.find((x) => x.id === ui.lastId) || null;
  const initials = (s) => String(s || "?").split(/[\s–-]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "?";
  const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const isMine = (l, e) => !!e && (l.entryId ? l.entryId === e.id : l.entry === e.label);
  const openPage = (hash) => chrome.runtime.sendMessage({ type: "OPEN_ENTRIES", hash });

  let lastStatus = "";
  function show(status, text) {
    lastStatus = status;
    $("foot").className = "status s-" + status;
    $("status").textContent = text;
    $("fabDot").className = "dot s-" + status;
    $("quick").classList.toggle("busy", status === "run");
    if (menu.hidden) {
      // Floating label next to the button while the menu is closed.
      $("toast").className = "toast s-" + status;
      $("toastText").textContent = text;
      $("toast").hidden = false;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => ($("toast").hidden = true), status === "fail" || status === "stuck" || status === "done" ? 12000 : 6000);
    }
  }

  // ---------- placement (drag along either edge) ----------
  function place() {
    host.style.top = ui.top + "%";
    host.style.left = ui.side === "left" ? "14px" : "";
    host.style.right = ui.side === "right" ? "14px" : "";
    [menu, $("toast")].forEach((n) => {
      n.classList.toggle("left", ui.side === "left");
      n.classList.toggle("up", ui.top > 50);
    });
    fitMenu();
  }

  // ✓ next to the button: one tap = Fill & Next with the selected entry.
  function syncQuick() {
    $("quick").hidden = locked || !menu.hidden || !current();
  }

  function applyUi() {
    place();
    syncQuick();
    host.setAttribute("data-state", locked ? "locked" : "ready");
    menu.classList.toggle("locked", locked);
    $("lockbox").hidden = !locked;
    $("lockText").textContent = lockReason;
    if (locked) $("fabDot").className = "dot";
    const checking = ui.mode === "check" || ui.mode === "checkDone";
    $("modebar").hidden = !checking;
    $("modeText").textContent = ui.mode === "checkDone" ? "Office check finished – nothing was selected." : "Office check – goes through the pages by itself, you solve the captcha.";
    $("log").hidden = !ui.showLog;
    $("logBtn").setAttribute("aria-expanded", String(!!ui.showLog));
    $("pageChip").textContent = pageType();
  }
  const saveUi = () => chrome.storage.local.set({ [UI_KEY]: ui });

  // ---------- entry dropdown ----------
  const hhmm = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  function renderPicker() {
    const e = current();
    $("pickAv").textContent = e ? initials(e.label) : "?";
    $("pickName").textContent = e ? e.label : entries.length ? "Choose an entry" : "No entries yet";
    syncQuick();
    const open = e && e.officeOpen;
    $("pickSub").textContent = e
      ? open
        ? "🟢 Open since " + hhmm(open.since) + (open.stillOpenAt && open.stillOpenAt > open.since ? ", still at " + hhmm(open.stillOpenAt) : "") + " · " + open.offices.slice(0, 2).join(", ")
        : (e.docType + " " + e.docNumber + " · " + [e.provinceText, (e.officeText || "").split(",")[0]].filter(Boolean).join(" · ")).trim()
      : entries.length ? entries.length + " saved – click to choose" : "Add one in Manage entries";
    $("actNext").disabled = !e;
    $("actCheck").disabled = !e;
  }

  function renderList() {
    renderPicker();
    const term = norm($("search").value);
    const list = $("list");
    list.textContent = "";
    $("search").hidden = entries.length <= 5;
    entries.forEach((e) => {
      const match = !term || [e.label, e.fullName, e.docNumber, e.provinceText].some((v) => norm(v).includes(term));
      if (!match) return;
      const b = document.createElement("button");
      b.className = "item" + (e.id === ui.lastId ? " sel" : "");
      b.setAttribute("role", "option");
      b.setAttribute("aria-selected", String(e.id === ui.lastId));
      const av = document.createElement("span");
      av.className = "av";
      av.textContent = initials(e.label);
      const t = document.createElement("span");
      t.className = "pk";
      const n = document.createElement("b");
      n.textContent = e.label;
      const sub = document.createElement("small");
      sub.textContent = e.docType + " " + e.docNumber + (e.provinceText ? " · " + e.provinceText : "");
      t.append(n, sub);
      b.append(av, t);
      b.addEventListener("click", () => {
        remember(e);
        toggleList(false);
        show("info", e.label + " selected. Press Fill & Next on each page.");
      });
      list.appendChild(b);
    });
    $("nomatch").hidden = !term || list.childElementCount > 0;
    if (!entries.length) {
      const d = document.createElement("div");
      d.className = "nomatch";
      d.textContent = "No entries yet – open Manage entries to add one.";
      list.appendChild(d);
    }
  }

  function toggleList(open) {
    const want = open == null ? $("listWrap").hidden : open;
    $("listWrap").hidden = !want;
    $("picker").setAttribute("aria-expanded", String(want));
    if (want) {
      renderList();
      if (!$("search").hidden) $("search").focus();
    }
  }

  function remember(e) {
    if (ui.lastId !== e.id) {
      ui.lastId = e.id;
      saveUi();
    }
    renderList();
    renderLog();
  }

  // ---------- recent activity (selected entry) ----------
  function renderLog() {
    const e = current();
    const mine = e ? logs.filter((l) => isMine(l, e)) : logs;
    $("logCnt").textContent = mine.length ? String(mine.length) : "";
    $("logBtn").querySelector("span").textContent = e ? "Recent activity – " + e.label : "Recent activity";
    const list = $("logList");
    list.textContent = "";
    const recent = mine.slice(-8).reverse();
    if (!recent.length) {
      const d = document.createElement("div");
      d.className = "nomatch";
      d.textContent = "No activity yet.";
      list.appendChild(d);
      return;
    }
    recent.forEach((l) => {
      const row = document.createElement("div");
      row.className = "logrow s-" + l.status;
      const dot = document.createElement("i");
      dot.className = "sdot";
      const time = document.createElement("time");
      time.textContent = fmtTime(l.t);
      const span = document.createElement("span");
      span.textContent = [l.page, l.action].filter(Boolean).join(" · ") + " — " + l.detail;
      row.append(dot, time, span);
      list.appendChild(row);
    });
  }

  // ---------- open / close ----------
  /**
   * Opens the menu towards the side of the button with more room and caps its height to
   * that room (it scrolls inside), so it never runs off the window. While open it sits
   * above other floating buttons (e.g. RelaySwitch's).
   */
  function fitMenu() {
    if (menu.hidden) return;
    if (matchMedia("(max-width: 520px)").matches) {
      menu.style.top = menu.style.bottom = menu.style.maxHeight = "";
      return; // phones: bottom sheet from the CSS
    }
    const r = fab.getBoundingClientRect();
    const gap = 8;
    const margin = 10;
    const below = window.innerHeight - r.bottom - gap - margin;
    const above = r.top - gap - margin;
    const up = above > below;
    menu.classList.toggle("up", up);
    menu.style.top = up ? "auto" : r.height + gap + "px";
    menu.style.bottom = up ? r.height + gap + "px" : "auto";
    menu.style.maxHeight = Math.max(160, Math.min(640, up ? above : below)) + "px";
  }
  addEventListener("resize", () => fitMenu());

  function openMenu() {
    menu.hidden = false;
    $("toast").hidden = true;
    host.style.zIndex = "2147483647";
    syncQuick();
    fab.setAttribute("aria-expanded", "true");
    applyUi();
    renderList();
    renderLog();
    if (!locked && !current() && entries.length) toggleList(true);
    fitMenu();
  }
  function closeMenu() {
    menu.hidden = true;
    host.style.zIndex = "2147483646";
    toggleList(false);
    syncQuick();
    fab.setAttribute("aria-expanded", "false");
  }

  // Drag to move along either edge; a short press toggles the menu.
  let drag = null;
  fab.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    drag = { x: ev.clientX, y: ev.clientY, moved: false };
    try { fab.setPointerCapture(ev.pointerId); } catch (_) {}
  });
  fab.addEventListener("pointermove", (ev) => {
    if (!drag) return;
    if (!drag.moved && Math.hypot(ev.clientX - drag.x, ev.clientY - drag.y) < 6) return;
    drag.moved = true;
    closeMenu();
    $("toast").hidden = true;
    ui.side = ev.clientX < window.innerWidth / 2 ? "left" : "right";
    ui.top = Math.min(92, Math.max(4, (ev.clientY / window.innerHeight) * 100));
    place();
  });
  fab.addEventListener("pointerup", () => {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    if (moved) {
      ui.top = Math.round(ui.top);
      saveUi();
    } else if (menu.hidden) openMenu();
    else closeMenu();
  });
  fab.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      menu.hidden ? openMenu() : closeMenu();
    }
  });
  $("toast").addEventListener("click", openMenu);
  $("quick").addEventListener("click", () => {
    if (locked) return openMenu();
    const e = current();
    if (!e) return openMenu();
    if ($("quick").classList.contains("busy")) return;
    doFillAndNext(e);
  });
  root.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      if (!$("listWrap").hidden) toggleList(false);
      else closeMenu();
      fab.focus();
    }
  });
  document.addEventListener("pointerdown", (ev) => {
    if (!menu.hidden && !ev.composedPath().includes(host)) closeMenu();
  }, true);

  // ---------- actions ----------
  const withEntry = (fn) => () => {
    if (locked) return openMenu();
    const e = current();
    if (!e) return toggleList(true);
    toggleList(false);
    fn(e);
  };
  $("actNext").addEventListener("click", withEntry((e) => {
    stopAuto();
    if (ui.mode !== "check") setMode(null);
    doFillAndNext(e);
  }));
  $("actCheck").addEventListener("click", withEntry((e) => {
    setMode("check");
    autoCount(0);
    lastStatus = "";
    show("info", "Office check: " + [e.provinceText, (e.tramiteText || "").split("(")[0].trim()].filter(Boolean).join(" · ") +
      ". CitaMate goes through the pages by itself – you only solve the captcha. It stops at the office list without booking.");
    if (pageType() === "Office") recordOffices();
    else autoStep();
  }));
  $("picker").addEventListener("click", () => toggleList());
  $("search").addEventListener("input", renderList);
  $("search").addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      const first = $("list").querySelector(".item");
      if (first) first.click();
    }
  });
  $("closeBtn").addEventListener("click", closeMenu);
  $("modeCancel").addEventListener("click", () => {
    stopAuto();
    setMode(null);
    show("info", "Back to normal mode.");
  });
  $("logBtn").addEventListener("click", () => {
    ui.showLog = !ui.showLog;
    applyUi();
    saveUi();
  });
  $("manage").addEventListener("click", () => openPage(""));
  $("lockOpen").addEventListener("click", () => openPage(""));
  $("lockRetry").addEventListener("click", () => load(true));
  $("openRecords").addEventListener("click", () => openPage("records/log"));
  $("openReport").addEventListener("click", () => {
    const e = current();
    openPage(e ? "records/entry/" + e.id : "records");
  });

  // Alt+Enter = continue the current mode with the selected entry (one page per key press).
  document.addEventListener(
    "keydown",
    (ev) => {
      if (!(ev.altKey && ev.key === "Enter")) return;
      ev.preventDefault();
      if (locked) return show("info", lockReason);
      stopAuto();
      const e = current();
      if (e) doFillAndNext(e);
      else show("info", "Open " + APP + " and choose an entry first.");
    },
    true,
  );

  // ---------- start-up: everything comes from the server ----------
  let loaded = false;
  async function load(force) {
    try {
      const r = await send("CM_GET_DATA", { what: ["entries", "logs", "siteConfig"], fresh: !!force });
      C = window.CM_SITE.hydrate(r.siteConfig);
      entries = Array.isArray(r.entries) ? r.entries : [];
      // Keep records this page queued but the worker hasn't seen yet.
      const ids = new Set((r.logs || []).map((l) => l.id));
      logs = (r.logs || []).concat(logs.filter((l) => !ids.has(l.id))).slice(-MAX_LOGS);
      locked = false;
    } catch (err) {
      locked = true;
      lockReason = (err && err.message) || "Sign in to CitaMate to use it on this page.";
    }
    applyUi();
    renderList();
    renderLog();
    if (!locked && !loaded) {
      loaded = true;
      checkOnLoad().then(recordOffices).then(() => {
        $("pageChip").textContent = pageType();
        autoStep();
      });
    }
  }

  // Sign-in / sign-out in another tab (the refresh token lives in storage.local).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes["cm.refresh"]) {
      if (!changes["cm.refresh"].newValue) {
        locked = true;
        lockReason = "You were signed out. Sign in to CitaMate to use it on this page.";
        entries = [];
        logs = [];
        applyUi();
        renderList();
        renderLog();
      } else load(true);
    }
  });
  // Coming back to the tab: pick up entries edited elsewhere (cached by the worker for 30 s).
  addEventListener("focus", () => load(false));

  chrome.storage.local.get([UI_KEY]).then((got) => {
    if (got[UI_KEY]) ui = { ...ui, ...got[UI_KEY] };
    let tabMode = null;
    try { tabMode = sessionStorage.getItem("citamate:mode"); } catch (_) {}
    ui.mode = tabMode === "check" || tabMode === "checkDone" ? tabMode : null;
    // Started from the panel's "Offices to check": #citamate-check=<entry id>.
    const startCheck = /(?:^#|&)citamate-check=([\w-]+)/.exec(location.hash);
    if (startCheck) {
      ui.lastId = startCheck[1];
      ui.mode = "check";
      try {
        sessionStorage.setItem("citamate:mode", "check");
        sessionStorage.setItem(AUTO_KEY, "0");
      } catch (_) {}
      history.replaceState(null, "", location.pathname + location.search);
      saveUi();
    }
    // Older versions stored a pixel position for the old box.
    if (ui.side !== "left" && ui.side !== "right") ui.side = "right";
    if (!(ui.top >= 4 && ui.top <= 92) || ui.right !== undefined) {
      ui.top = 70;
      delete ui.right;
      delete ui.collapsed;
    }
    applyUi();
    renderList();
    renderLog();
    document.documentElement.appendChild(host);
    load(false);
  });

  function CSS() {
    return `
:host { all: initial; }
* { box-sizing: border-box; }
.menu, .menu *, .toast, .toast * { font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #1b1f24; }
[hidden] { display: none !important; }
.fab { position: relative; width: 50px; height: 50px; border: 0; padding: 0; border-radius: 15px; background: none; cursor: pointer;
  display: block; touch-action: none; filter: drop-shadow(0 5px 12px rgba(15,23,42,.35)); opacity: .94; transition: transform .15s, opacity .15s; }
.fab svg { display: block; width: 100%; height: 100%; }
.fab:hover, .fab[aria-expanded="true"] { opacity: 1; transform: scale(1.06); }
.fab:focus-visible { outline: 2px solid #0d9488; outline-offset: 3px; }
.dot { position: absolute; right: -3px; top: -3px; width: 14px; height: 14px; border-radius: 50%; background: #94a3b8; border: 2px solid #fff; }
.s-ok.dot, .s-done.dot { background: #16a34a; } .s-fail.dot { background: #dc2626; }
.s-stuck.dot, .s-wait.dot { background: #d97706; } .s-run.dot { background: #2563eb; animation: cf-pulse 1s ease-in-out infinite; }
@keyframes cf-pulse { 50% { opacity: .35; } }

.quick { position: absolute; top: 57px; left: 7px; width: 36px; height: 36px; border-radius: 50%; border: 2px solid #fff; padding: 0;
  display: grid; place-items: center; cursor: pointer; background: linear-gradient(135deg, #fb923c, #ea580c); color: #fff;
  box-shadow: 0 4px 12px rgba(234,88,12,.45); transition: transform .12s; }
.quick svg { width: 18px; height: 18px; }
.quick:hover { transform: scale(1.08); }
.quick:active { transform: scale(.94); }
.quick.busy { pointer-events: none; }
.quick.busy svg { display: none; }
.quick.busy::after { content: ""; width: 16px; height: 16px; border-radius: 50%; border: 2.5px solid rgba(255,255,255,.4); border-top-color: #fff; animation: cm-spin .8s linear infinite; }
@keyframes cm-spin { to { transform: rotate(360deg); } }
.toast { position: absolute; right: 60px; top: 6px; width: max-content; max-width: 300px; display: flex; gap: 8px; align-items: flex-start;
  padding: 8px 12px; border-radius: 10px; background: #fff; border: 1px solid #dfe3ea; box-shadow: 0 8px 24px rgba(15,23,42,.22); cursor: pointer; }
.toast.left { right: auto; left: 60px; }
.toast span { font-size: 12.5px; }
.toast.s-fail { background: #fef2f2; border-color: #fecaca; } .toast.s-stuck, .toast.s-wait { background: #fffbeb; border-color: #fde68a; }
.toast.s-done, .toast.s-ok { background: #f0fdf4; border-color: #bbf7d0; }

.menu { position: absolute; right: 0; top: 58px; width: 344px; max-height: min(620px, calc(100vh - 90px)); overflow: auto;
  background: #fff; border: 1px solid #dfe3ea; border-radius: 14px; box-shadow: 0 14px 40px rgba(15,23,42,.28); }
.menu.left { right: auto; left: 0; }
.menu.up { top: auto; bottom: 58px; }
.head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #eef0f3; position: sticky; top: 0; background: #fff; z-index: 1; }
.head .logo svg { width: 22px; height: 22px; display: block; }
.head strong { font-weight: 800; font-size: 14px; }
.chip { margin-left: auto; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 999px; background: #e0f2fe; color: #075985; }
.x { border: 0; background: none; cursor: pointer; padding: 2px 6px; border-radius: 6px; color: #64748b; }
.x:hover { background: #f1f5f9; }
.modebar { display: flex; align-items: center; gap: 8px; padding: 7px 12px; background: #ccfbf1; }
.modebar span { flex: 1; font-size: 12px; font-weight: 600; color: #115e59; }
.modebar button { background: #fff; border: 1px solid #5eead4; border-radius: 6px; padding: 2px 8px; cursor: pointer; font-size: 12px; color: #115e59; }

.lockbox { display: flex; flex-direction: column; gap: 8px; padding: 14px 12px; }
.lockbox b { font-size: 14px; font-weight: 800; }
.lockbox span { color: #475569; font-size: 12.5px; }
.locked .section, .locked .acts, .locked #foot, .locked .offices, .locked .fold, .locked .log, .locked .modebar, .locked .chip { display: none !important; }
.section { padding: 10px 12px 4px; }
.lbl { font-size: 11px; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: .05em; margin-bottom: 5px; }
.picker, .item { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; border: 1px solid #dfe3ea; background: #fff;
  border-radius: 10px; padding: 8px 10px; cursor: pointer; }
.picker:hover { border-color: #0d9488; }
.picker[aria-expanded="true"] { border-color: #0d9488; box-shadow: 0 0 0 3px rgba(13,148,136,.15); }
.picker .chev { margin-left: auto; color: #64748b; }
.av { flex: none; width: 30px; height: 30px; border-radius: 9px; display: grid; place-items: center; font-size: 12px !important; font-weight: 800 !important;
  color: #fff !important; background: linear-gradient(135deg, #1e3a8a, #0d9488); }
.pk { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.pk b { font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pk small { font-size: 11.5px; color: #64748b; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.list { margin-top: 6px; border: 1px solid #dfe3ea; border-radius: 10px; padding: 6px; max-height: 260px; overflow: auto; }
.search { display: block; width: 100%; margin: 0 0 6px; padding: 7px 9px; border-radius: 8px; border: 1px solid #dfe3ea; outline: none; }
.search:focus { border-color: #0d9488; }
.item { border-color: transparent; padding: 7px 8px; background: transparent; }
.item:hover, .item:focus-visible { background: #f1f5f9; outline: none; }
.item.sel { background: #f0fdfa; border-color: #99f6e4; }
.item .av { width: 26px; height: 26px; font-size: 11px !important; }
.nomatch { padding: 8px; color: #64748b; font-size: 12px; }

.acts { display: grid; grid-template-columns: 1fr; gap: 6px; padding: 10px 12px; }
.btn { display: flex; align-items: center; justify-content: center; gap: 7px; }
.btn svg { width: 17px; height: 17px; flex: none; }
.btn .k { font: 11px ui-monospace, Menlo, monospace !important; color: #ffedd5 !important; margin-left: 8px; opacity: .85; }
.btn { border-radius: 9px; padding: 11px 8px; font-size: 14px !important; font-weight: 700 !important; cursor: pointer; border: 1px solid #ea580c; white-space: nowrap; }
.btn.primary { background: #ea580c; color: #fff !important; }
.btn.primary:hover { background: #c2410c; }
.btn.ghost { background: #fff; color: #ea580c !important; }
.btn.teal { background: #fff; color: #0f766e !important; border-color: #14b8a6; }
.btn:disabled { opacity: .45; cursor: not-allowed; }

.status { display: flex; gap: 8px; align-items: flex-start; margin: 0 12px 10px; padding: 8px 10px; border-radius: 9px; background: #f8fafc; font-size: 12.5px; }
.status.s-fail { background: #fef2f2; } .status.s-stuck, .status.s-wait { background: #fffbeb; }
.status.s-done, .status.s-ok { background: #f0fdf4; } .status.s-run { background: #eff6ff; }
.sdot { flex: none; width: 9px; height: 9px; border-radius: 50%; margin-top: 4px; background: #94a3b8; }
.s-ok .sdot, .s-done .sdot { background: #16a34a; } .s-fail .sdot { background: #dc2626; }
.s-stuck .sdot, .s-wait .sdot { background: #d97706; } .s-run .sdot { background: #2563eb; }

.offices { margin: 0 12px 10px; border: 1px solid #ccfbf1; border-radius: 10px; overflow: hidden; }
.offh { padding: 6px 10px; font-weight: 700 !important; background: #f0fdfa; color: #115e59 !important; font-size: 12px !important; }
.off { padding: 6px 10px; border-top: 1px solid #f1f5f9; }
.off b { display: block; font-weight: 600; }
.off span { color: #64748b; font-size: 11px; }
.off.mine { background: #dcfce7; }

.fold { display: flex; align-items: center; gap: 6px; width: 100%; border: 0; border-top: 1px solid #eef0f3; background: #fff; padding: 9px 12px; cursor: pointer; text-align: left; }
.fold span:first-of-type { font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fold .cnt { font-size: 11px; color: #64748b; background: #f1f5f9; border-radius: 999px; padding: 0 7px; }
.fold .chev { margin-left: auto; color: #64748b; }
.fold[aria-expanded="true"] .chev { transform: rotate(180deg); }
.log { max-height: 200px; overflow: auto; border-top: 1px solid #f1f5f9; }
.logrow { display: flex; gap: 7px; padding: 6px 12px; border-bottom: 1px solid #f6f7f9; }
.logrow * { font-size: 11.5px !important; }
.logrow time { color: #64748b; flex: none; }
.logrow span { min-width: 0; overflow-wrap: anywhere; }
.logrow .sdot { margin-top: 4px; width: 7px; height: 7px; }

.foot { display: flex; align-items: center; gap: 11px; padding: 9px 12px; border-top: 1px solid #eef0f3; background: #f8fafc; flex-wrap: wrap; }
.foot a { color: #0f766e; cursor: pointer; font-weight: 600; font-size: 12px; text-decoration: none; display: inline-flex; align-items: center; gap: 5px; }
.foot a svg { width: 15px; height: 15px; }
.fold svg { width: 15px; height: 15px; flex: none; color: #64748b; }
.foot a:hover { text-decoration: underline; }
.kbd { margin-left: auto; font: 11px ui-monospace, Menlo, monospace !important; color: #64748b; border: 1px solid #dfe3ea; border-bottom-width: 2px; border-radius: 5px; padding: 0 5px; }

/* Phones / narrow windows: compact bottom sheet with icons and only the essentials. */
@media (max-width: 560px) {
  .fab { width: 42px; height: 42px; border-radius: 12px; }
  .dot { width: 11px; height: 11px; }
  .quick { top: 48px; left: 5px; width: 32px; height: 32px; }
  .quick svg { width: 16px; height: 16px; }
  .toast { right: 52px; top: 4px; max-width: calc(100vw - 84px); padding: 6px 10px; }
  .toast span { font-size: 12px; }
  .menu, .menu.left, .menu.up { position: fixed; left: 8px; right: 8px; bottom: 8px; top: auto; width: auto;
    max-height: 60vh; border-radius: 14px; box-shadow: 0 -6px 30px rgba(15,23,42,.3); }
  .menu, .menu * { font-size: 12.5px; }
  .head { padding: 7px 10px; gap: 6px; }
  .head .logo svg { width: 18px; height: 18px; }
  .head strong { font-size: 13px; }
  .chip { font-size: 10px; padding: 1px 6px; }
  .x { padding: 2px 6px; }
  .lbl, .fold, .log, .k, .kbd { display: none !important; }
  .section { padding: 8px 10px 0; }
  .picker { padding: 6px 8px; gap: 8px; border-radius: 9px; }
  .picker .av { width: 24px; height: 24px; font-size: 10px !important; border-radius: 7px; }
  .picker .pk small { display: none; }
  .list { max-height: 34vh; padding: 4px; }
  .item { padding: 6px; gap: 8px; }
  .item .av { width: 22px; height: 22px; font-size: 10px !important; }
  .item .pk small { font-size: 11px; }
  .search { font-size: 16px !important; padding: 6px 8px; }
  .acts { padding: 8px 10px; }
  .btn { padding: 9px 8px; font-size: 14px !important; border-radius: 9px; }
  .status { margin: 0 10px 8px; padding: 6px 8px; font-size: 12px; }
  .status span { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .offices { margin: 0 10px 8px; max-height: 110px; overflow: auto; }
  .off { padding: 4px 8px; } .off span { display: none; }
  .foot { justify-content: space-around; gap: 0; padding: 4px 6px; flex-wrap: nowrap; }
  .foot a { flex-direction: column; gap: 1px; font-size: 10px !important; padding: 4px 10px; font-weight: 600; }
  .foot a svg { width: 19px; height: 19px; }
}
@media (prefers-color-scheme: dark) {
  .menu, .menu *, .toast, .toast * { color: #e6e9ef; }
  .menu, .head, .fold, .picker, .search { background: #1b202a; border-color: #2c3342; }
  .toast { background: #1b202a; border-color: #2c3342; }
  .head, .fold, .foot, .log, .logrow, .off { border-color: #2c3342; }
  .foot, .status { background: #161a22; }
  .item:hover { background: #232a36; } .item.sel { background: #12312e; border-color: #115e59; }
  .pk small, .lbl, .nomatch, .logrow time, .x, .chev { color: #9aa3b5 !important; }
  .btn.ghost, .btn.teal { background: #1b202a; }
  .list { border-color: #2c3342; }
  .status.s-fail, .toast.s-fail { background: #3a1717; } .status.s-ok, .status.s-done, .toast.s-ok, .toast.s-done { background: #12301c; }
  .status.s-stuck, .status.s-wait, .toast.s-stuck { background: #3a2c0c; } .status.s-run { background: #172554; }
  .offices { border-color: #134e4a; } .offh { background: #12312e; color: #99f6e4 !important; } .off.mine { background: #14532d; }
  .chip { background: #0c4a6e; color: #bae6fd !important; }
  .modebar { background: #134e4a; } .modebar span { color: #ccfbf1; } .modebar button { background: #1b202a; }
  .lockbox span { color: #9aa3b5; }
  .foot a { color: #5eead4; } .kbd { border-color: #2c3342; } .fold .cnt { background: #232a36; }
  .dot { border-color: #1b202a; }
}`;
  }
})();
