// Panel shell: session restore, role-based nav, hash router, owner filter.
import { get, refresh, logout, goLogin } from "./api.js";
import { el, toastError } from "./ui.js";
import { state } from "./state.js";
import dashboard from "./pages/dashboard.js";
import entries from "./pages/entries.js";
import proxies from "./pages/proxies.js";
import activity from "./pages/activity.js";
import devices from "./pages/devices.js";
import account from "./pages/account.js";
import users from "./pages/users.js";
import settings from "./pages/settings.js";
import config from "./pages/config.js";
import audit from "./pages/audit.js";

const ROUTES = { dashboard, entries, proxies, activity, devices, account, users, settings, config, audit };
const ADMIN_ROUTES = new Set(["users", "settings", "config", "audit"]);

const main = document.getElementById("main");
const sidebar = document.getElementById("sidebar");
let renderSeq = 0;

async function boot() {
  try {
    await refresh();
  } catch (_) {
    goLogin(false);
    return;
  }
  try {
    const me = await get("/auth/me");
    state.user = me.user;
    state.entitlements = me.entitlements || [];
  } catch (e) {
    toastError(e);
    return;
  }
  const isAdmin = state.user.role === "admin";
  document.querySelectorAll(".admin-only").forEach((n) => (n.hidden = !isAdmin));
  document.getElementById("whoami").textContent = `${state.user.username} · ${isAdmin ? "Admin" : "User"}`;
  if (isAdmin) {
    try {
      state.users = (await get("/admin/users")).items || [];
    } catch (_) {
      state.users = [];
    }
  }
  window.addEventListener("hashchange", render);
  render();
}

export async function render() {
  const seq = ++renderSeq;
  let name = (location.hash || "#dashboard").slice(1).split("?")[0];
  if (!ROUTES[name] || (ADMIN_ROUTES.has(name) && state.user.role !== "admin")) name = "dashboard";
  document.querySelectorAll("#nav a").forEach((a) => {
    if (a.dataset.route === name) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  sidebar.classList.remove("open");
  document.getElementById("menuBtn").setAttribute("aria-expanded", "false");
  main.textContent = "";
  main.append(el("div", { class: "loading" }, "Loading…"));
  try {
    const node = await ROUTES[name]();
    if (seq !== renderSeq) return; // user navigated away meanwhile
    main.textContent = "";
    main.append(node);
    main.focus({ preventScroll: true });
  } catch (e) {
    if (seq !== renderSeq) return;
    main.textContent = "";
    main.append(el("div", { class: "card" }, el("p", { class: "form-error" }, e.message || "Could not load this page.")));
  }
}

document.getElementById("signOut").addEventListener("click", async () => {
  await logout();
  location.href = "/login?signedout=1";
});
document.getElementById("menuBtn").addEventListener("click", (e) => {
  const open = sidebar.classList.toggle("open");
  e.currentTarget.setAttribute("aria-expanded", String(open));
});

boot();
