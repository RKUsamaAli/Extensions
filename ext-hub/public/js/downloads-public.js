// Public download page (/downloads/): extension cards + install guide. No sign-in needed.
import { el, skeletonTiles } from "./ui.js";
import { extensionGrid, installGuide } from "./extensions.js";

const grid = document.getElementById("grid");
grid.replaceChildren(el("div", { class: "ext-grid" }, skeletonTiles(2)));
document.getElementById("guide").append(installGuide());

fetch("/api/v1/public/downloads", { headers: { Accept: "application/json" } })
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))
  .then((d) => grid.replaceChildren(extensionGrid(d.items, d.publicUrl)))
  .catch(() => grid.replaceChildren(el("div", { class: "card form-error" }, "Couldn't load the packages. Reload the page in a moment.")));
