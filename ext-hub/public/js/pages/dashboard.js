import { get, qs } from "../api.js";
import { el, entitlementBadge, table } from "../ui.js";
import { state, EXTS, extName, ownerParam, ownerSelect, pageHead, isAdmin } from "../state.js";
import { EXTENSIONS, latestOf } from "../extensions.js";

/** Small "Get the extensions" strip: icon, name, version, download. */
function downloadStrip(dl) {
  return el("div", { class: "card", testid: "dashboard-downloads" },
    el("div", { class: "row space" }, el("h2", null, "Get the extensions"), el("a", { href: "#downloads", class: "btn small" }, "Install guide")),
    el("div", { class: "dl-strip" }, EXTENSIONS.map((x) => {
      const pkg = latestOf(dl.items, x.id);
      return el("div", { class: "dl-item" },
        el("img", { src: x.icon, alt: "", width: "36", height: "36" }),
        el("div", { class: "dl-text" }, el("strong", null, x.name), el("span", { class: "hint" }, pkg ? "Version " + pkg.version : "Not built yet")),
        pkg ? el("a", { class: "btn primary small", href: pkg.url, download: pkg.file, testid: "dashboard-download-" + x.id }, "Download") : null);
    })));
}

export default async function dashboard() {
  const root = el("div");
  async function load() {
    const [d, dl] = await Promise.all([get("/dashboard" + qs({ owner: ownerParam() })), get("/downloads").catch(() => ({ items: [] }))]);
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
      downloadStrip(dl),
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
