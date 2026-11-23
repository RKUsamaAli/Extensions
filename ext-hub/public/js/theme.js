// Theme: System / Light / Dark. Classic script loaded in <head> so the page
// never flashes the wrong colours. Choice kept per browser.
(function () {
  "use strict";
  var KEY = "exthub.theme";
  var root = document.documentElement;
  function get() {
    try { return localStorage.getItem(KEY) || "system"; } catch (_) { return "system"; }
  }
  function apply(mode) {
    if (mode === "light" || mode === "dark") root.setAttribute("data-theme", mode);
    else root.removeAttribute("data-theme");
  }
  function set(mode) {
    try { localStorage.setItem(KEY, mode); } catch (_) { /* private mode */ }
    apply(mode);
    document.querySelectorAll(".theme-switch button").forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
    });
  }
  apply(get());
  function mount(container) {
    if (!container) return;
    container.textContent = "";
    var wrap = document.createElement("div");
    wrap.className = "theme-switch";
    wrap.setAttribute("role", "group");
    wrap.setAttribute("aria-label", "Theme");
    [["system", "Auto"], ["light", "Light"], ["dark", "Dark"]].forEach(function (m) {
      var b = document.createElement("button");
      b.type = "button";
      b.dataset.mode = m[0];
      b.textContent = m[1];
      b.setAttribute("aria-pressed", String(get() === m[0]));
      b.addEventListener("click", function () { set(m[0]); });
      wrap.appendChild(b);
    });
    container.appendChild(wrap);
  }
  window.ExtHubTheme = { mount: mount, set: set, get: get };
  document.addEventListener("DOMContentLoaded", function () {
    document.querySelectorAll("[data-theme-switch]").forEach(mount);
  });
})();
