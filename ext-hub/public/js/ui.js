// Small DOM toolkit: everything is built with textContent, never innerHTML.

export function el(tag, props, ...kids) {
  const n = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k === "dataset") Object.assign(n.dataset, v);
      else if (k === "testid") n.setAttribute("data-testid", v);
      else if (k === "onclick" && typeof v === "function" && (tag === "button" || tag === "a")) n.addEventListener("click", busyClick(n, v));
      else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
      else if (k === "value") n.value = v;
      else if (k === "checked" || k === "selected" || k === "disabled") n[k] = !!v;
      else n.setAttribute(k, v === true ? "" : v);
    }
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    n.append(c instanceof Node ? c : String(c));
  }
  return n;
}

export const $ = (sel, root = document) => root.querySelector(sel);

// ---------- busy buttons ----------
/**
 * Shows a spinner on a button and disables it while an action runs, so a second
 * click can't send the same request twice. setBusy(btn, true, "Saving…").
 */
export function setBusy(btn, busy, label) {
  if (!btn) return;
  if (busy) {
    if (btn.dataset.busy) return;
    btn.dataset.busy = "1";
    btn.dataset.wasDisabled = btn.disabled ? "1" : "";
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    btn.classList.add("is-busy");
    if (label) { btn.dataset.label = btn.textContent; btn.textContent = label; }
    btn.prepend(el("span", { class: "spinner", "aria-hidden": "true" }));
  } else {
    if (!btn.dataset.busy) return;
    if (btn.dataset.label !== undefined) { btn.textContent = btn.dataset.label; delete btn.dataset.label; }
    const sp = btn.querySelector(":scope > .spinner");
    if (sp) sp.remove();
    btn.disabled = !!btn.dataset.wasDisabled;
    btn.removeAttribute("aria-busy");
    btn.classList.remove("is-busy");
    delete btn.dataset.busy;
    delete btn.dataset.wasDisabled;
  }
}

/**
 * form.addEventListener("submit", busySubmit(form, async () => …, "Saving…")): the submit
 * button shows a spinner and the form can't be sent again until the handler finishes.
 */
export function busySubmit(form, handler, label) {
  return async (e) => {
    e.preventDefault();
    const btn = form.querySelector("button[type=submit]");
    if (form.dataset.busy) return;
    form.dataset.busy = "1";
    setBusy(btn, true, label);
    try {
      await handler(e);
    } finally {
      delete form.dataset.busy;
      setBusy(btn, false);
    }
  };
}

/** Click handler wrapper: if the handler returns a promise, the button is busy until it settles. */
function busyClick(btn, handler) {
  return (e) => {
    if (btn.dataset.busy) { e.preventDefault(); return; }
    let r;
    try { r = handler(e); } catch (err) { throw err; }
    if (r && typeof r.then === "function") {
      setBusy(btn, true);
      r.finally(() => setBusy(btn, false)).catch(() => {});
    }
    return r;
  };
}

// ---------- skeletons (placeholders while data loads) ----------
const W = ["w-90", "w-70", "w-80", "w-60", "w-75", "w-50"];
export const skel = (cls = "") => el("span", { class: "skel " + cls, "aria-hidden": "true" });

/** Placeholder table rows. */
export function skeletonRows(cols, n = 6) {
  return Array.from({ length: n }, (_, i) => el("tr", { class: "skel-row", "aria-hidden": "true" },
    Array.from({ length: cols }, (_, j) => el("td", null, skel(W[(i + j) % W.length])))));
}

/** Placeholder for a whole page while its data loads (title, toolbar, tiles, table). */
export function skeletonPage() {
  return el("div", { class: "skel-page", role: "status", "aria-label": "Loading", testid: "page-skeleton" },
    el("div", { class: "page-head" }, skel("skel-title")),
    el("div", { class: "toolbar" }, skel("skel-input"), skel("skel-btn")),
    el("div", { class: "table-wrap" }, el("table", null,
      el("thead", null, el("tr", null, Array.from({ length: 5 }, () => el("th", null, skel("w-50"))))),
      el("tbody", null, skeletonRows(5, 8)))));
}

/** Placeholder stat tiles. */
export function skeletonTiles(n = 6) {
  return Array.from({ length: n }, () => el("div", { class: "card stat", "aria-hidden": "true" }, skel("skel-num"), skel("w-70"), skel("w-50 skel-small")));
}

// ---------- formatting ----------
export function fmtTime(t) {
  if (!t) return "—";
  return new Date(t).toLocaleString([], { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
export function fmtDate(t) {
  if (!t) return "—";
  return new Date(t).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}
export function ago(t) {
  if (!t) return "never";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return m + " min ago";
  const h = Math.round(m / 60);
  if (h < 24) return h + " h ago";
  const d = Math.round(h / 24);
  return d < 30 ? d + " d ago" : fmtDate(t);
}
/** epoch ms -> "YYYY-MM-DD" in local time (for <input type=date>). */
export function toDateInput(t) {
  if (!t) return "";
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
/** "YYYY-MM-DD" -> epoch ms at the END of that local day (access lasts the whole day). */
export function fromDateInput(s) {
  if (!s) return null;
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
}

export function badge(text, kind) {
  return el("span", { class: "badge" + (kind ? " " + kind : "") }, text);
}

export function entitlementBadge(e) {
  if (!e) return badge("No access", "bad");
  if (!e.expiresAt) return badge("Never expires", "ok");
  if (e.expiresAt < Date.now() || e.active === false) return badge("Expired " + fmtDate(e.expiresAt), "bad");
  const days = Math.ceil((e.expiresAt - Date.now()) / 86_400_000);
  return badge("Until " + fmtDate(e.expiresAt) + (days <= 7 ? ` (${days} d)` : ""), days <= 7 ? "warn" : "ok");
}

// ---------- toasts ----------
let toastBox = null;
export function toast(message, kind = "") {
  if (!toastBox) {
    toastBox = el("div", { class: "toasts", role: "status", "aria-live": "polite", testid: "toasts" });
    document.body.append(toastBox);
  }
  const t = el("div", { class: "toast " + kind, testid: "toast" }, message);
  toastBox.append(t);
  setTimeout(() => t.remove(), kind === "error" ? 7000 : 4000);
}
export const toastError = (e) => toast((e && e.message) || String(e), "error");

// ---------- tables ----------
const PAGE_ROWS = 50;

function rowNode(columns, r) {
  return el("tr", { testid: "row" }, columns.map((c) => {
    const v = c.render(r);
    return el("td", { class: c.class || null }, v == null || v === "" ? "—" : v);
  }));
}

/**
 * Table in its own scroll box that loads the next page when you scroll near the end.
 *   fetchPage(cursor) -> { items, next (cursor or null), total? }   (first call: cursor undefined)
 *   onPage({ loaded, total, done })   after every page (for "x of y" lines)
 * Returns the element; element.reload() starts again from the first page.
 */
export function scrollTable(columns, { fetchPage, empty = "Nothing here yet.", testid = "table", onPage } = {}) {
  const tbody = el("tbody");
  const status = el("td", { colspan: String(columns.length), class: "load-cell" });
  const loadRow = el("tr", { class: "load-row", testid: testid + "-loader" }, status);
  const box = el("div", { class: "table-wrap scroll-list", testid: testid + "-scroll" },
    el("table", { testid }, el("thead", null, el("tr", null, columns.map((c) => el("th", { scope: "col" }, c.label)))), tbody));
  let cursor;
  let done = false;
  let busy = false;
  let loaded = 0;
  let total = null;
  let gen = 0;

  const setStatus = (kind, text, retry) => {
    status.textContent = "";
    loadRow.dataset.state = kind;
    if (kind === "loading") status.append(el("span", { class: "spinner", "aria-hidden": "true" }), " ", text);
    else status.append(text);
    if (retry) status.append(" ", el("button", { type: "button", class: "btn small", onclick: () => next() }, "Try again"));
  };

  async function next() {
    if (busy || done) return;
    busy = true;
    const my = gen;
    const skeleton = loaded ? [] : skeletonRows(columns.length, 6);
    for (const sk of skeleton) tbody.insertBefore(sk, loadRow);
    if (loaded) setStatus("loading", "Loading more…");
    else { status.textContent = ""; loadRow.dataset.state = "first"; }
    try {
      const r = await fetchPage(cursor);
      if (my !== gen) return; // reloaded meanwhile
      skeleton.forEach((sk) => sk.remove());
      const items = r.items || [];
      for (const it of items) tbody.insertBefore(rowNode(columns, it), loadRow);
      loaded += items.length;
      if (typeof r.total === "number") total = r.total;
      cursor = r.next;
      done = r.next === null || r.next === undefined || !items.length;
      if (!loaded) setStatus("empty", empty);
      else if (done) setStatus("done", total !== null ? `All ${total} shown` : `All ${loaded} shown`);
      else setStatus("idle", total !== null ? `${loaded} of ${total} · scroll for more` : "Scroll for more");
      if (onPage) onPage({ loaded, total, done });
    } catch (e) {
      if (my !== gen) return;
      tbody.querySelectorAll(".skel-row").forEach((sk) => sk.remove());
      setStatus("error", (e && e.message) || "Could not load.", true);
    } finally {
      if (my === gen) busy = false;
    }
    // Still room on screen (short pages, tall window): keep going.
    if (my === gen && !done && box.isConnected && loadRow.getBoundingClientRect().top < box.getBoundingClientRect().bottom + 200) next();
  }

  tbody.append(loadRow);
  const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) next(); }, { root: box, rootMargin: "0px 0px 300px 0px" });
  io.observe(loadRow);
  box.reload = () => {
    gen++;
    busy = false;
    done = false;
    cursor = undefined;
    loaded = 0;
    total = null;
    tbody.textContent = "";
    tbody.append(loadRow);
    return next();
  };
  next();
  return box;
}

/**
 * columns: [{ label, render(row) -> Node|string, class? }]
 * Rows get data-testid="row". Long lists render PAGE_ROWS at a time in their own
 * scroll box and add more as you scroll (fast even with thousands of rows).
 */
export function table(columns, rows, { empty = "Nothing here yet.", testid = "table" } = {}) {
  if (!rows.length) return el("div", { class: "table-wrap" }, el("div", { class: "empty", testid: testid + "-empty" }, empty));
  if (rows.length > PAGE_ROWS + 10) {
    return scrollTable(columns, {
      testid,
      empty,
      fetchPage: async (from = 0) => ({ items: rows.slice(from, from + PAGE_ROWS), next: from + PAGE_ROWS < rows.length ? from + PAGE_ROWS : null, total: rows.length }),
    });
  }
  return el(
    "div",
    { class: "table-wrap" },
    el("table", { testid }, el("thead", null, el("tr", null, columns.map((c) => el("th", { scope: "col" }, c.label)))), el("tbody", null, rows.map((r) => rowNode(columns, r)))),
  );
}

// ---------- drawer & dialogs ----------
function trapEscape(overlay, close) {
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  return () => document.removeEventListener("keydown", onKey);
}

/**
 * Opens a side drawer. onSave(form) may throw ApiError (validation fields are shown).
 * Returns { close }.
 */
export function drawer({ title, body, saveLabel = "Save", onSave, wide = false, testid = "drawer" }) {
  const err = el("div", { class: "form-error", hidden: true, role: "alert", testid: "form-error" });
  const saveBtn = el("button", { type: "submit", class: "btn primary", testid: "drawer-save" }, saveLabel);
  const cancelBtn = el("button", { type: "button", class: "btn", testid: "drawer-cancel" }, "Cancel");
  const form = el(
    "form",
    { class: "drawer", role: "dialog", "aria-modal": "true", "aria-label": title, testid, novalidate: true },
    el("header", null, el("h2", null, title), el("button", { type: "button", class: "btn small", "aria-label": "Close", onclick: () => close() }, "✕")),
    el("div", { class: "body" }, err, body),
    el("footer", null, cancelBtn, saveBtn),
  );
  const panel = form;
  if (wide) panel.style.width = "min(48rem, 100%)";
  const overlay = el("div", { class: "overlay" }, panel);
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  let untrap = () => {};
  function close() { untrap(); overlay.remove(); }
  async function submit(e) {
    if (e) e.preventDefault();
    err.hidden = true;
    form.querySelectorAll(".field-error").forEach((n) => n.remove());
    if (saveBtn.dataset.busy) return;
    setBusy(saveBtn, true, /^save/i.test(saveLabel) ? "Saving…" : saveLabel === "Add all" ? "Adding…" : saveLabel);
    cancelBtn.disabled = true;
    try {
      const keep = await onSave(form);
      if (keep !== false) close();
    } catch (ex) {
      showFormError(form, err, ex);
    } finally {
      setBusy(saveBtn, false);
      cancelBtn.disabled = false;
    }
  }
  form.addEventListener("submit", submit);
  cancelBtn.addEventListener("click", close);
  document.body.append(overlay);
  untrap = trapEscape(overlay, close);
  const first = form.querySelector("input:not([type=hidden]), select, textarea");
  if (first) first.focus();
  return { close, form };
}

export function showFormError(form, errBox, ex) {
  errBox.textContent = (ex && ex.message) || "Something went wrong.";
  errBox.hidden = false;
  const fields = ex && ex.body && ex.body.fields;
  if (fields) {
    for (const [name, msg] of Object.entries(fields)) {
      const input = form.querySelector(`[name="${CSS.escape(name)}"]`);
      if (input) input.closest("label")?.append(el("div", { class: "field-error" }, msg));
    }
  }
}

/** Simple modal confirm → Promise<boolean>. */
export function confirmDialog(message, { okLabel = "Delete", danger = true, title = "Are you sure?" } = {}) {
  return new Promise((resolve) => {
    const ok = el("button", { type: "button", class: "btn " + (danger ? "primary danger-fill" : "primary"), testid: "confirm-ok" }, okLabel);
    if (danger) { ok.style.background = "var(--danger)"; ok.style.borderColor = "var(--danger)"; ok.style.color = "#fff"; }
    const cancel = el("button", { type: "button", class: "btn", testid: "confirm-cancel" }, "Cancel");
    const box = el(
      "div",
      { class: "dialog", role: "alertdialog", "aria-modal": "true", "aria-label": title, testid: "confirm" },
      el("header", null, el("h2", null, title)),
      el("div", { class: "body" }, el("p", null, message)),
      el("footer", null, cancel, ok),
    );
    const overlay = el("div", { class: "overlay center" }, box);
    let untrap = () => {};
    const done = (v) => { untrap(); overlay.remove(); resolve(v); };
    ok.addEventListener("click", () => done(true));
    cancel.addEventListener("click", () => done(false));
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) done(false); });
    document.body.append(overlay);
    untrap = trapEscape(overlay, () => done(false));
    cancel.focus();
  });
}

// ---------- form helpers ----------
export function field(label, input, { wide = false, hint } = {}) {
  return el("label", { class: wide ? "wide" : null }, label, input, hint ? el("div", { class: "hint" }, hint) : null);
}
export function input(name, value, attrs = {}) {
  return el("input", { type: "text", name, id: "f-" + name, value: value ?? "", ...attrs });
}
export function select(name, options, value, attrs = {}) {
  const s = el("select", { name, id: "f-" + name, ...attrs });
  for (const o of options) s.append(el("option", { value: o.value }, o.text));
  s.value = value ?? "";
  return s;
}
export function formValues(form) {
  const out = {};
  form.querySelectorAll("input[name], select[name], textarea[name]").forEach((n) => {
    if (n.type === "checkbox") out[n.name] = n.checked;
    else out[n.name] = n.value;
  });
  return out;
}

export function downloadJson(name, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = el("a", { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function pickFile(accept) {
  return new Promise((resolve) => {
    const inp = el("input", { type: "file", accept });
    inp.addEventListener("change", () => resolve(inp.files && inp.files[0] ? inp.files[0] : null));
    inp.click();
  });
}
