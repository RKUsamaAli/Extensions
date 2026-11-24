// Office alerts in the panel: live stream, bell with unread count, desktop notification,
// sound and toast. Pages listen to the "eh:alert" window event to update live.
import { get, post, stream } from "./api.js";
import { el, toast, drawer, fmtTime, ago } from "./ui.js";

let unread = 0;
let lastT = 0;
let bell = null;

const hm = (t) => (t ? new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "");
const short = (s) => String(s || "").split(",")[0].trim();
const title = (a) => `${a.province} · ${short(a.tramite).split("(")[0].trim()}`;
const summary = (a) =>
  (a.stillOpen ? `Still open (since ${hm(a.openSince)}, checked ${hm(a.t)})` : `Just opened at ${hm(a.t)}`) +
  ` – ${a.offices.length} office${a.offices.length === 1 ? "" : "s"}: ${a.offices.map((o) => short(o.text)).join(", ")}`;

function setUnread(n) {
  unread = Math.max(0, n);
  if (!bell) return;
  bell.querySelector(".bell-count").textContent = unread ? String(unread) : "";
  bell.classList.toggle("has-unread", unread > 0);
  bell.setAttribute("aria-label", unread ? `Office alerts, ${unread} new` : "Office alerts");
}

function chime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.18, 0.36].forEach((d, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = [660, 880, 1100][i];
      g.gain.setValueAtTime(0.0001, ctx.currentTime + d);
      g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + d + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + d + 0.16);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + d);
      o.stop(ctx.currentTime + d + 0.18);
    });
  } catch (_) { /* no audio here */ }
}

function desktopNotify(a) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try {
    const n = new Notification((a.stillOpen ? "Still open · " : "Offices open · ") + title(a), {
      body: summary(a),
      tag: "office-" + a.province + "-" + a.tramite, // a newer alert for the same pair replaces the old one
      icon: "/img/citamate.svg",
      requireInteraction: false,
    });
    n.onclick = () => {
      window.focus();
      location.hash = "#availability";
      n.close();
    };
  } catch (_) { /* notifications blocked */ }
}

function onAlert(a, { quiet = false } = {}) {
  if (a.t <= lastT) return;
  lastT = a.t;
  setUnread(unread + 1);
  window.dispatchEvent(new CustomEvent("eh:alert", { detail: a }));
  if (quiet) return;
  chime();
  desktopNotify(a);
  toast(`🔔 ${title(a)}: ${summary(a)}`, "ok");
}

function openList() {
  const list = el("div", { class: "alert-list", testid: "alert-list" }, el("div", { class: "loading" }, "Loading…"));
  const perm = "Notification" in window ? Notification.permission : "unsupported";
  const permRow =
    perm === "granted"
      ? el("p", { class: "hint" }, "Desktop notifications are on.")
      : perm === "denied"
        ? el("p", { class: "hint" }, "Desktop notifications are blocked for this site – allow them in the browser's site settings.")
        : perm === "unsupported"
          ? null
          : el("button", { type: "button", class: "btn", testid: "enable-notifications", onclick: async () => { await Notification.requestPermission(); permRow.replaceWith(el("p", { class: "hint" }, Notification.permission === "granted" ? "Desktop notifications are on." : "Notifications were not allowed.")); } }, "Turn on desktop notifications");
  drawer({
    title: "Office alerts",
    saveLabel: "Mark all as read",
    testid: "alerts-drawer",
    body: el("div", { class: "stack wide-stack" },
      el("p", { class: "hint" }, "Alerts for the province + trámite pairs you watch (bell on the Offices pages). Each check anyone makes can alert everyone, at most once per minute per pair."),
      permRow,
      el("a", { href: "#availability", class: "btn small", onclick: () => document.querySelector("[data-testid=alerts-drawer] [data-testid=drawer-cancel]")?.click() }, "Open office availability"),
      list),
    onSave: async () => {
      await post("/citamate/alerts/seen", {});
      setUnread(0);
    },
  });
  get("/citamate/alerts?limit=50").then((r) => {
    list.textContent = "";
    if (!r.items.length) return list.append(el("p", { class: "hint" }, "No alerts yet. Watch a province + trámite on the Offices to check or Availability page."));
    for (const a of r.items) {
      list.append(el("div", { class: "alert-item" + (a.t > r.seenAt ? " unread" : "") },
        el("div", { class: "row space" }, el("strong", null, title(a)), el("span", { class: "hint", title: fmtTime(a.t) }, ago(a.t))),
        el("div", null, a.stillOpen ? `Still open · open since ${hm(a.openSince)} · checked ${hm(a.t)}` : `Just opened · checked ${hm(a.t)}`),
        el("ul", { class: "alert-offices" }, a.offices.map((o) => el("li", null, short(o.text), el("span", { class: "hint" }, ` since ${hm(o.since)}`), (a.newOffices || []).some((n) => n.value === o.value) ? el("span", { class: "badge info" }, "new") : null)))));
    }
  }).catch(() => (list.textContent = "Couldn't load the alerts."));
}

/** Starts the bell + live stream (users with CitaMate access and admins). */
export async function startAlerts(sidebarSlot) {
  bell = el("button", { type: "button", class: "alert-bell", testid: "alerts-bell", "aria-label": "Office alerts", onclick: openList },
    el("span", { "aria-hidden": "true" }, "🔔"), el("span", null, "Office alerts"), el("span", { class: "bell-count", testid: "alerts-count" }));
  sidebarSlot.append(bell);
  try {
    const r = await get("/citamate/alerts?limit=1");
    setUnread(r.unread);
    lastT = r.items[0] ? r.items[0].t : Date.now();
  } catch (_) {
    bell.remove(); // no CitaMate access
    return;
  }
  stream("/citamate/alerts/stream", (name, data) => name === "alert" && onAlert(data), {
    // After a reconnect: fetch what came in meanwhile, without a burst of notifications.
    onOpen: async () => {
      try {
        const r = await get("/citamate/alerts?limit=20&since=" + lastT);
        r.items.reverse().forEach((a) => onAlert(a, { quiet: true }));
        setUnread(r.unread);
      } catch (_) { /* next reconnect will try again */ }
    },
  });
}
