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
/**
 * columns: [{ label, render(row) -> Node|string, class? }]
 * Rows get data-testid="row".
 */
export function table(columns, rows, { empty = "Nothing here yet.", testid = "table" } = {}) {
  if (!rows.length) return el("div", { class: "table-wrap" }, el("div", { class: "empty", testid: testid + "-empty" }, empty));
  return el(
    "div",
    { class: "table-wrap" },
    el(
      "table",
      { testid },
      el("thead", null, el("tr", null, columns.map((c) => el("th", { scope: "col" }, c.label)))),
      el(
        "tbody",
        null,
        rows.map((r) =>
          el("tr", { testid: "row" }, columns.map((c) => {
            const v = c.render(r);
            return el("td", { class: c.class || null }, v == null || v === "" ? "—" : v);
          })),
        ),
      ),
    ),
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
    saveBtn.disabled = true;
    try {
      const keep = await onSave(form);
      if (keep !== false) close();
    } catch (ex) {
      showFormError(form, err, ex);
    } finally {
      saveBtn.disabled = false;
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
