import { post, logout } from "../api.js";
import { el, field, input, toast, showFormError, entitlementBadge, table } from "../ui.js";
import { state, pageHead, extName } from "../state.js";

export default async function accountPage() {
  const err = el("div", { class: "form-error", hidden: true, role: "alert", testid: "password-error" });
  const form = el(
    "form",
    { class: "stack", novalidate: true, testid: "password-form" },
    err,
    field("Current password", input("current", "", { type: "password", autocomplete: "current-password", testid: "password-current" })),
    field("New password", input("next", "", { type: "password", autocomplete: "new-password", minlength: 8, testid: "password-next" }), { hint: "At least 8 characters." }),
    field("Repeat new password", input("next2", "", { type: "password", autocomplete: "new-password", testid: "password-next2" })),
    el("div", null, el("button", { type: "submit", class: "btn primary", testid: "password-save" }, "Change password")),
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.hidden = true;
    const v = Object.fromEntries(new FormData(form));
    try {
      if (String(v.next).length < 8) throw new Error("The new password needs at least 8 characters.");
      if (v.next !== v.next2) throw new Error("The new passwords don't match.");
      await post("/auth/password", { current: v.current, next: v.next });
      form.reset();
      toast("Password changed. Other devices were signed out.", "ok");
    } catch (ex) {
      showFormError(form, err, ex.code === "invalid_credentials" ? new Error("The current password is wrong.") : ex);
    }
  });

  const u = state.user;
  return el(
    "div",
    null,
    pageHead("My account"),
    el(
      "div",
      { class: "card" },
      el("h2", null, "Profile"),
      el("p", null, "Username: ", el("strong", { testid: "account-username" }, u.username)),
      el("p", null, "Email: ", u.email || "—"),
      el("p", null, "Role: ", u.role === "admin" ? "Admin" : "User"),
      table(
        [
          { label: "Extension", render: (r) => extName(r.ext) },
          { label: "Access", render: (r) => entitlementBadge(r) },
          { label: "Max devices", render: (r) => String(r.maxDevices ?? "—") },
        ],
        state.entitlements,
        { testid: "account-entitlements", empty: u.role === "admin" ? "Admins can use every extension." : "No access to any extension yet." },
      ),
    ),
    el("div", { class: "card" }, el("h2", null, "Change password"), form),
    el(
      "div",
      { class: "card" },
      el("h2", null, "Sign out"),
      el("p", { class: "hint" }, "Signs out this browser. To sign out an extension, remove its device on the Devices page."),
      el("button", {
        type: "button",
        class: "btn",
        testid: "account-sign-out",
        onclick: async () => { await logout(); location.href = "/login?signedout=1"; },
      }, "Sign out of this browser"),
    ),
  );
}
