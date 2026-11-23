// Admin: users, approval, roles, expiry dates (entitlements).
import { get, post, put, del } from "../api.js";
import { el, table, drawer, confirmDialog, toast, toastError, field, input, select, fmtTime, ago, badge, entitlementBadge, toDateInput, fromDateInput } from "../ui.js";
import { state, EXTS, pageHead } from "../state.js";

const ROLES = [{ value: "user", text: "User" }, { value: "admin", text: "Admin" }];

function statusBadge(u) {
  if (u.pending) return badge("Waiting for approval", "warn");
  if (!u.enabled) return badge("Disabled", "bad");
  return badge("Active", "ok");
}

/** Entitlement rows: checkbox + expiry date + max devices per extension. */
function entitlementEditor(current) {
  const byExt = Object.fromEntries((current || []).map((e) => [e.ext, e]));
  const rows = EXTS.map((x) => {
    const cur = byExt[x.id];
    const on = el("input", { type: "checkbox", checked: !!cur, testid: `ent-${x.id}-enabled`, "aria-label": `Access to ${x.name}` });
    const date = el("input", { type: "date", value: cur ? toDateInput(cur.expiresAt) : "", testid: `ent-${x.id}-expires`, "aria-label": `${x.name} access until` });
    const max = el("input", { type: "number", min: 1, max: 100, value: cur ? cur.maxDevices ?? 2 : 2, testid: `ent-${x.id}-maxDevices`, "aria-label": `${x.name} max devices` });
    const sync = () => { date.disabled = !on.checked; max.disabled = !on.checked; };
    on.addEventListener("change", sync);
    sync();
    const quick = (days) =>
      el("button", {
        type: "button",
        class: "btn small",
        onclick: () => {
          on.checked = true;
          sync();
          const base = date.value ? Math.max(fromDateInput(date.value), Date.now()) : Date.now();
          date.value = toDateInput(base + days * 86_400_000);
        },
      }, `+${days} d`);
    return {
      ext: x.id,
      node: el(
        "div",
        { class: "card", testid: `ent-${x.id}` },
        el("label", { class: "check" }, on, el("strong", null, x.name)),
        el(
          "div",
          { class: "form-grid" },
          el("label", null, "Access until", date, el("span", { class: "hint" }, "Empty = never expires")),
          el("label", null, "Max devices", max),
        ),
        el("div", { class: "row" }, quick(30), quick(90), quick(365), el("button", { type: "button", class: "btn small", onclick: () => { date.value = ""; } }, "Never")),
      ),
      value: () => (on.checked ? { ext: x.id, expiresAt: fromDateInput(date.value), maxDevices: Math.max(1, Number(max.value) || 1) } : null),
    };
  });
  return {
    node: el("div", { class: "stack" }, el("h3", null, "Extension access"), rows.map((r) => r.node)),
    value: () => rows.map((r) => r.value()).filter(Boolean),
  };
}

function fieldError(fields) {
  const e = new Error("Please fix the marked fields.");
  e.body = { fields };
  return e;
}

function openCreate(onDone) {
  const ents = entitlementEditor([]);
  drawer({
    title: "New user",
    saveLabel: "Create user",
    testid: "user-drawer",
    body: el(
      "div",
      { class: "stack" },
      el(
        "div",
        { class: "form-grid" },
        field("Username *", input("username", "", { autocapitalize: "none", spellcheck: "false", testid: "user-username" })),
        field("Password *", input("password", "", { type: "text", autocomplete: "off", testid: "user-password" }), { hint: "At least 8 characters. Give it to the user." }),
        field("Email", input("email", "", { type: "email", testid: "user-email" })),
        field("Role", select("role", ROLES, "user", { testid: "user-role" })),
        field("Note", input("note", "", { testid: "user-note" }), { wide: true }),
      ),
      ents.node,
    ),
    async onSave(form) {
      const v = Object.fromEntries(new FormData(form));
      const f = {};
      if (!/^[A-Za-z0-9._-]{3,40}$/.test(String(v.username || "").trim())) f.username = "3–40 characters: letters, digits, . _ -";
      if (String(v.password || "").length < 8) f.password = "At least 8 characters";
      if (Object.keys(f).length) throw fieldError(f);
      await post("/admin/users", {
        username: v.username.trim(),
        password: v.password,
        email: v.email.trim() || null,
        role: v.role,
        note: v.note.trim() || null,
        entitlements: ents.value(),
      });
      toast(`User ${v.username.trim()} created.`, "ok");
      onDone();
    },
  });
}

function openEdit(u, onDone) {
  const ents = entitlementEditor(u.entitlements);
  const isSelf = u.id === state.user.id;
  const enabled = el("input", { type: "checkbox", name: "enabled", checked: u.enabled && !u.pending, disabled: isSelf, testid: "user-enabled" });
  drawer({
    title: "Edit " + u.username,
    testid: "user-drawer",
    body: el(
      "div",
      { class: "stack" },
      el(
        "div",
        { class: "form-grid" },
        field("Username", input("username", u.username, { autocapitalize: "none", spellcheck: "false", testid: "user-username" })),
        field("Email", input("email", u.email, { type: "email", testid: "user-email" })),
        field("Role", select("role", ROLES, u.role, { disabled: isSelf, testid: "user-role" }), isSelf ? { hint: "You can't change your own role." } : {}),
        field("New password", input("password", "", { type: "text", autocomplete: "off", placeholder: "Leave empty to keep", testid: "user-password" }), { hint: "Setting one signs the user out everywhere." }),
        field("Note", input("note", u.note, { testid: "user-note" }), { wide: true }),
        el("label", { class: "check wide" }, enabled, u.pending ? "Approve and enable this account" : "Account enabled"),
      ),
      ents.node,
    ),
    async onSave(form) {
      const v = Object.fromEntries(new FormData(form));
      const f = {};
      if (!/^[A-Za-z0-9._-]{3,40}$/.test(String(v.username || "").trim())) f.username = "3–40 characters: letters, digits, . _ -";
      if (v.password && v.password.length < 8) f.password = "At least 8 characters";
      if (Object.keys(f).length) throw fieldError(f);
      const patch = { username: v.username.trim(), email: v.email.trim() || null, note: v.note.trim() || null };
      if (!isSelf) {
        patch.role = v.role;
        patch.enabled = enabled.checked;
        if (enabled.checked) patch.pending = false;
      }
      if (v.password) patch.password = v.password;
      await put("/admin/users/" + encodeURIComponent(u.id), patch);
      await put(`/admin/users/${encodeURIComponent(u.id)}/entitlements`, { items: ents.value() });
      toast("User saved.", "ok");
      onDone();
    },
  });
}

export default async function usersPage() {
  const root = el("div");
  const search = el("input", { type: "search", placeholder: "Search username, email, note…", "aria-label": "Search users", testid: "users-search" });
  const statusSel = el("select", { "aria-label": "Status", testid: "users-status" });
  [["", "All statuses"], ["pending", "Waiting for approval"], ["active", "Active"], ["disabled", "Disabled"], ["expiring", "Expiring within 7 days"]].forEach(([v, t]) => statusSel.append(el("option", { value: v }, t)));
  const listBox = el("div");
  let items = [];

  const act = (label, testid, fn, cls = "btn small") =>
    el("button", { type: "button", class: cls, testid, onclick: async () => { try { await fn(); } catch (e) { toastError(e); } } }, label);

  function draw() {
    const term = search.value.trim().toLowerCase();
    const st = statusSel.value;
    const soon = Date.now() + 7 * 86_400_000;
    const rows = items
      .filter((u) => !term || [u.username, u.email, u.note].some((v) => String(v || "").toLowerCase().includes(term)))
      .filter((u) =>
        !st ? true
        : st === "pending" ? u.pending
        : st === "active" ? u.enabled && !u.pending
        : st === "disabled" ? !u.enabled && !u.pending
        : (u.entitlements || []).some((e) => e.expiresAt && e.expiresAt > Date.now() && e.expiresAt < soon),
      );
    const cols = [
      { label: "User", render: (u) => el("div", null, el("strong", null, u.username), u.email ? el("div", { class: "hint" }, u.email) : null) },
      { label: "Role", render: (u) => (u.role === "admin" ? badge("Admin", "info") : "User") },
      { label: "Status", render: (u) => statusBadge(u) },
      ...EXTS.map((x) => ({
        label: x.name,
        render: (u) => {
          if (u.role === "admin") return badge("Always", "info");
          const e = (u.entitlements || []).find((y) => y.ext === x.id);
          return e ? el("span", null, entitlementBadge(e), el("div", { class: "hint" }, `max ${e.maxDevices} devices`)) : badge("No access");
        },
      })),
      { label: "Last sign-in", render: (u) => el("span", { title: fmtTime(u.lastLoginAt) }, ago(u.lastLoginAt)) },
      {
        label: "",
        class: "actions",
        render: (u) => {
          const self = u.id === state.user.id;
          return el(
            "span",
            null,
            u.pending
              ? act("Approve", "row-approve", async () => {
                  await put("/admin/users/" + encodeURIComponent(u.id), { pending: false, enabled: true });
                  toast(`${u.username} approved. Give them extension access with Edit.`, "ok");
                  load();
                })
              : null,
            act("Edit", "row-edit", () => openEdit(u, load)),
            !self && !u.pending
              ? act(u.enabled ? "Disable" : "Enable", "row-toggle", async () => {
                  if (u.enabled && !(await confirmDialog(`Disable ${u.username}? They are signed out everywhere at once.`, { okLabel: "Disable" }))) return;
                  await put("/admin/users/" + encodeURIComponent(u.id), { enabled: !u.enabled });
                  toast(u.enabled ? "User disabled." : "User enabled.", "ok");
                  load();
                })
              : null,
            act("Sign out", "row-signout", async () => {
              if (!(await confirmDialog(`Sign ${u.username} out of every browser and extension?`, { okLabel: "Sign out", danger: false }))) return;
              await post(`/admin/users/${encodeURIComponent(u.id)}/sign-out`);
              toast(`${u.username} was signed out everywhere.`, "ok");
              if (self) location.href = "/login?signedout=1";
            }),
            !self
              ? act("Delete", "row-delete", async () => {
                  if (!(await confirmDialog(`Delete ${u.username} and ALL their entries, proxies, logs and devices? This can't be undone.`))) return;
                  await del("/admin/users/" + encodeURIComponent(u.id));
                  toast("User deleted.", "ok");
                  load();
                }, "btn small danger")
              : null,
          );
        },
      },
    ];
    listBox.textContent = "";
    listBox.append(table(cols, rows, { testid: "users-table", empty: items.length ? "No user matches." : "No users yet." }), el("p", { class: "hint" }, `${rows.length} of ${items.length} users`));
  }

  async function load() {
    try {
      items = (await get("/admin/users")).items || [];
      state.users = items;
    } catch (e) { toastError(e); }
    draw();
  }

  search.addEventListener("input", draw);
  statusSel.addEventListener("change", draw);
  root.append(
    pageHead("Users", el("button", { type: "button", class: "btn primary", testid: "user-create", onclick: () => openCreate(load) }, "New user")),
    el("div", { class: "toolbar" }, search, statusSel),
    listBox,
  );
  await load();
  return root;
}
