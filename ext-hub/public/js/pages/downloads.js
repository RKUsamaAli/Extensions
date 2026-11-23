// Panel: Get extensions – same cards and install guide as the public page, plus your access.
import { get } from "../api.js";
import { el, entitlementBadge, badge } from "../ui.js";
import { state, pageHead, isAdmin } from "../state.js";
import { extensionGrid, installGuide } from "../extensions.js";

function accessBadge(x) {
  if (isAdmin()) return badge("Admin: full access", "ok");
  return entitlementBadge(state.entitlements.find((e) => e.ext === x.id));
}

export default async function downloadsPage() {
  const r = await get("/downloads");
  return el(
    "div",
    { testid: "downloads-page" },
    pageHead("Get the extensions", el("a", { class: "btn", href: "/downloads/", target: "_blank", rel: "noopener", testid: "public-downloads-link" }, "Public download page ↗")),
    el("p", { class: "hint" }, "Packages built for this server. Share the public page with your users: ", el("span", { class: "mono" }, location.origin + "/downloads/")),
    extensionGrid(r.items, r.publicUrl, { extra: (x) => el("div", { class: "ext-access" }, el("span", { class: "hint" }, "Your access: "), accessBadge(x)) }),
    installGuide(),
  );
}
