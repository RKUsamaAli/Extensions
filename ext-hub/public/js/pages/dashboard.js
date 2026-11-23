import { get, qs } from "../api.js";
import { el, entitlementBadge, table } from "../ui.js";
import { state, EXTS, extName, ownerParam, ownerSelect, pageHead, isAdmin } from "../state.js";

export default async function dashboard() {
  const root = el("div");
  async function load() {
    const d = await get("/dashboard" + qs({ owner: ownerParam() }));
    const c = d.counts || {};
    const stats = [
      ["CitaMate entries", c.profiles, "#entries"],
      ["Proxies", c.proxies, "#proxies"],
      ["Devices", c.devices, "#devices"],
      ["Log records (7 days)", c.logs7d, "#activity"],
      ["Bookings (7 days)", c.bookings7d, "#activity"],
    ];
    if (c.users != null) stats.push(["Users", c.users, "#users"]);
    const ents = d.entitlements || state.entitlements;
    root.textContent = "";
    root.append(
      pageHead("Dashboard", ownerSelect(load)),
      el(
        "div",
        { class: "grid", testid: "stats" },
        stats.map(([label, n, href]) =>
          el("a", { class: "card stat", href, testid: "stat" }, el("b", null, String(n ?? 0)), el("span", null, label)),
        ),
      ),
      el(
        "div",
        { class: "card" },
        el("h2", null, state.owner ? "Access" : "My access"),
        isAdmin() && !state.owner
          ? el("p", { class: "hint" }, "Admins can use every extension without an expiry date.")
          : null,
        table(
          [
            { label: "Extension", render: (r) => extName(r.ext) },
            { label: "Status", render: (r) => entitlementBadge(r.missing ? null : r) },
            { label: "Max devices", render: (r) => (r.missing ? "—" : String(r.maxDevices ?? "—")) },
          ],
          ents.length || state.owner ? ents : EXTS.map((e) => ({ ext: e.id, missing: true })),
          { testid: "entitlements", empty: "No access to any extension yet. Ask the admin." },
        ),
      ),
    );
  }
  await load();
  return root;
}
