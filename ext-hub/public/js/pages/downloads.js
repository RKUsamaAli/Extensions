// Extensions: download the packages built for this server, with install steps.
import { get } from "../api.js";
import { el, fmtTime, entitlementBadge, badge } from "../ui.js";
import { state, EXTS, pageHead, isAdmin } from "../state.js";

const ABOUT = {
  citamate: "Fills the cita pages with your saved entries, one click per page, and records every result.",
  relayswitch: "Switch between the proxies in your account from the toolbar, with an exit-IP check.",
};

const kb = (n) => (n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");

function accessBadge(ext) {
  if (isAdmin()) return badge("Admin: full access", "ok");
  return entitlementBadge(state.entitlements.find((e) => e.ext === ext));
}

function extCard(x, item, publicUrl) {
  return el(
    "div",
    { class: "card ext-card", testid: "download-" + x.id },
    el("div", { class: "ext-head" }, el("h2", null, x.name), item ? badge("Version " + item.version, "info") : null, accessBadge(x.id)),
    el("p", { class: "hint" }, ABOUT[x.id] || ""),
    item
      ? [
          el(
            "div",
            { class: "toolbar" },
            el("a", { class: "btn primary", href: item.url, download: item.file, testid: "download-" + x.id + "-link" }, "Download " + x.name),
            el("span", { class: "hint" }, `${item.file} · ${kb(item.size)} · built ${fmtTime(item.builtAt)}`),
          ),
          el("p", { class: "hint" }, "Server address already set inside: ", el("span", { class: "mono" }, publicUrl)),
        ]
      : el("p", { class: "hint" }, "No package on this server yet. It is built by ", el("span", { class: "mono" }, "sudo exthub-deploy"), "."),
  );
}

export default async function downloadsPage() {
  const r = await get("/downloads");
  const items = r.items || [];
  const latest = (ext) => items.find((i) => i.ext === ext) || null;
  const step = (title, ...body) => el("li", null, el("strong", null, title), " ", ...body);
  return el(
    "div",
    { testid: "downloads-page" },
    pageHead("Extensions"),
    el("p", { class: "hint" }, "Packages built for this server. Install them in Chrome, Edge or Brave, then sign in with your ext-hub account."),
    EXTS.map((x) => extCard(x, latest(x.id), r.publicUrl)),
    el(
      "div",
      { class: "card", testid: "install-steps" },
      el("h2", null, "How to install"),
      el(
        "ol",
        { class: "steps" },
        step("Download", "the zip above and unzip it into a folder you keep. Don't delete or move the folder later: the browser loads the extension from it."),
        step("Open", el("span", { class: "mono" }, "chrome://extensions"), " (Edge: ", el("span", { class: "mono" }, "edge://extensions"), ") and switch on ", el("em", null, "Developer mode"), "."),
        step("Click", el("em", null, "Load unpacked"), " and pick the unzipped folder."),
        step("Pin it", "with the puzzle-piece icon in the toolbar, open it and sign in with your username and password."),
      ),
      el("h3", null, "Updating"),
      el("p", { class: "hint" }, "Download the new zip, unzip it over the same folder, then click the reload icon on the extension's card in chrome://extensions. Your data stays in your account."),
    ),
  );
}
