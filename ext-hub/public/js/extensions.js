// What the download pages show: extension details, cards and the install guide.
// Used by the public page (/downloads/) and the panel page (Get extensions).
import { el } from "./ui.js";

export const EXTENSIONS = [
  {
    id: "citamate",
    name: "CitaMate",
    icon: "/img/citamate.svg",
    tagline: "Your cita helper for the ICP appointment pages",
    about: "Fills each page of the cita booking with one click, presses the right button, and keeps a record of every result – so you always know where a booking stands.",
    features: [
      "One-click Fill & Next on every page of the booking",
      "Entries come from your account (managed in the web panel)",
      "Sees which offices have appointments and keeps a history",
      "Records every step; failures include page details to fix fast",
    ],
    works: "Chrome · Edge · Brave",
  },
  {
    id: "relayswitch",
    name: "RelaySwitch",
    icon: "/img/relayswitch.svg",
    tagline: "Switch between your proxies in one click",
    about: "Your proxies, from any provider, in the toolbar and on every page. Picks the best ones first, logs in for you and checks your exit IP.",
    features: [
      "Proxies come from your account (managed in the web panel)",
      "Best score first: reliability and speed of every proxy",
      "Proxy login, sessions and an exit-IP check",
      "Floating button on pages to switch or turn off quickly",
    ],
    works: "Chrome · Edge · Brave · Opera · Arc",
  },
];

const kb = (n) => (n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");
const day = (t) => (t ? new Date(t).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" }) : "");

/** Newest package per extension from a /downloads listing. */
export const latestOf = (items, id) => (items || []).find((i) => i.ext === id) || null;

/**
 * Grid of extension cards. opts.extra(x) adds a node under the details (e.g. access badge).
 */
export function extensionGrid(items, publicUrl, { extra } = {}) {
  return el(
    "div",
    { class: "ext-grid", testid: "ext-grid" },
    EXTENSIONS.map((x) => {
      const pkg = latestOf(items, x.id);
      return el(
        "article",
        { class: "ext-tile", testid: "download-" + x.id },
        el(
          "header",
          { class: "ext-tile-head" },
          el("img", { src: x.icon, alt: "", width: "56", height: "56", class: "ext-icon" }),
          el("div", null,
            el("h2", null, x.name),
            el("p", { class: "ext-tagline" }, x.tagline)),
        ),
        el("p", { class: "ext-about" }, x.about),
        el("ul", { class: "ext-features" }, x.features.map((f) => el("li", null, f))),
        el(
          "dl",
          { class: "ext-meta" },
          el("div", null, el("dt", null, "Version"), el("dd", null, pkg ? pkg.version : "—")),
          el("div", null, el("dt", null, "Size"), el("dd", null, pkg ? kb(pkg.size) : "—")),
          el("div", null, el("dt", null, "Updated"), el("dd", null, pkg ? day(pkg.builtAt) : "—")),
          el("div", null, el("dt", null, "Works in"), el("dd", null, x.works)),
        ),
        extra ? extra(x, pkg) : null,
        el(
          "div",
          { class: "ext-actions" },
          pkg
            ? el("a", { class: "btn primary ext-download", href: pkg.url, download: pkg.file, testid: "download-" + x.id + "-link" }, "⬇ Download " + x.name)
            : el("span", { class: "hint" }, "Not built on this server yet (built by exthub-deploy)."),
          pkg ? el("span", { class: "hint mono" }, pkg.file) : null,
        ),
        publicUrl ? el("p", { class: "hint ext-server" }, "Signs in to ", el("span", { class: "mono" }, publicUrl), " – already set inside.") : null,
      );
    }),
  );
}

/** The install guide (what a README would say), written for the people who use the extensions. */
export function installGuide() {
  const step = (n, title, ...body) => el("li", { class: "guide-step" }, el("span", { class: "guide-n", "aria-hidden": "true" }, String(n)), el("div", null, el("strong", null, title), el("p", null, ...body)));
  const kbd = (t) => el("span", { class: "kbd" }, t);
  return el(
    "section",
    { class: "card guide", testid: "install-guide" },
    el("h2", null, "Install guide"),
    el("ol", { class: "guide-steps" },
      step(1, "Download", "Click ", el("b", null, "Download"), " above and unzip the file into a folder you keep, for example ", el("span", { class: "mono" }, "Documents/Extensions/CitaMate"), ". Don't delete or move the folder later – the browser loads the extension from it."),
      step(2, "Open the extensions page", "Type ", kbd("chrome://extensions"), " in the address bar (Edge: ", kbd("edge://extensions"), ", Brave: ", kbd("brave://extensions"), ") and switch on ", el("b", null, "Developer mode"), " in the top right."),
      step(3, "Load it", "Click ", el("b", null, "Load unpacked"), " and pick the folder you unzipped – the one that contains ", el("span", { class: "mono" }, "manifest.json"), "."),
      step(4, "Pin and sign in", "Click the puzzle-piece icon in the toolbar, pin the extension, open it and sign in with the username and password of your account."),
    ),
    el("div", { class: "guide-more" },
      el("div", null, el("h3", null, "Updating"), el("p", null, "Download the new zip, unzip it over the same folder, then click the reload icon ↻ on the extension's card in the extensions page. Your data is in your account, so nothing is lost.")),
      el("div", null, el("h3", null, "Where is my data?"), el("p", null, "Entries and proxies are kept in your account on this server and managed in the web panel. The extensions read them after you sign in.")),
      el("div", null, el("h3", null, "Something wrong?"), el("p", null, "Signed out unexpectedly, “access expired” or “device limit”: ask your admin. Chrome shows a “developer mode” notice at start – that's normal for extensions installed this way."))),
  );
}
