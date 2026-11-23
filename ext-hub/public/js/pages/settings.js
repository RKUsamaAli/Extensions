import { get, put } from "../api.js";
import { el, field, toast, showFormError } from "../ui.js";
import { EXTS, pageHead } from "../state.js";

export default async function settingsPage() {
  const { values: v } = await get("/admin/settings");
  const err = el("div", { class: "form-error", hidden: true, role: "alert" });
  const allowSignup = el("input", { type: "checkbox", name: "allowSignup", checked: !!v.allowSignup, testid: "settings-allowSignup" });
  const retention = el("input", { type: "number", name: "logRetentionDays", min: 1, max: 3650, value: v.logRetentionDays ?? 90, testid: "settings-logRetentionDays" });
  const perExt = EXTS.map((x) => {
    const enabled = el("input", { type: "checkbox", checked: !(v.enabled && v.enabled[x.id] === false), testid: `settings-enabled-${x.id}` });
    const minVersion = el("input", { type: "text", value: (v.minVersion && v.minVersion[x.id]) || "", placeholder: "e.g. 1.6.0", pattern: "\\d+(\\.\\d+){0,3}", testid: `settings-minVersion-${x.id}` });
    return {
      x,
      enabled,
      minVersion,
      node: el(
        "div",
        { class: "card" },
        el("h3", null, x.name),
        el("label", { class: "check" }, enabled, "Extension switched on"),
        el("p", { class: "hint" }, "Switched off: every install shows \"switched off by admin\" and stops working."),
        field("Minimum version", minVersion, { hint: "Older installs are asked to update. Empty = any version." }),
      ),
    };
  });
  const form = el(
    "form",
    { novalidate: true, testid: "settings-form" },
    err,
    el(
      "div",
      { class: "card" },
      el("h2", null, "Accounts"),
      el("label", { class: "check" }, allowSignup, "Allow sign-ups (new accounts wait for approval)"),
    ),
    perExt.map((p) => p.node),
    el("div", { class: "card" }, el("h2", null, "Data"), el("div", { class: "stack" }, field("Keep logs for (days)", retention, { hint: "Older log records and office sightings are deleted every night." }))),
    el("div", { class: "toolbar" }, el("button", { type: "submit", class: "btn primary", testid: "settings-save" }, "Save settings")),
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.hidden = true;
    try {
      for (const p of perExt) {
        const mv = p.minVersion.value.trim();
        if (mv && !/^\d+(\.\d+){0,3}$/.test(mv)) throw new Error(`${p.x.name}: minimum version must look like 1.6.0`);
      }
      const values = {
        allowSignup: allowSignup.checked,
        logRetentionDays: Math.max(1, Number(retention.value) || 90),
        minVersion: Object.fromEntries(perExt.map((p) => [p.x.id, p.minVersion.value.trim() || null])),
        enabled: Object.fromEntries(perExt.map((p) => [p.x.id, p.enabled.checked])),
      };
      await put("/admin/settings", values);
      toast("Settings saved.", "ok");
    } catch (ex) {
      showFormError(form, err, ex);
    }
  });
  return el("div", null, pageHead("Settings"), form);
}
