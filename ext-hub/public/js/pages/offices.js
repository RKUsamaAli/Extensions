// Offices to check: one row per province + trámite of everyone's active entries (pending /
// in progress), stalest first. "Check" claims the pair for 3 minutes and opens the cita site
// with CitaMate in office-check mode for one of your own entries for it.
import { get, post } from "../api.js";
import { el, table, toast, toastError, badge, fmtTime, ago } from "../ui.js";
import { pageHead } from "../state.js";

export const CITA_START = "https://icp.administracionelectronica.gob.es/icpplus/index.html";
const hm = (t) => (t ? new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "");
const short = (s) => String(s || "").split(",")[0].trim();

export function statusBadge(r) {
  if (r.status === "open") return badge(`Open since ${hm(r.openSince)}`, "ok");
  if (r.status === "closed") return badge("Closed", "bad");
  if (r.status === "stale") return badge(r.offices && r.offices.length ? "Was open (old)" : "Closed (old)", "warn");
  return badge("Never checked");
}

/** Badge + one line: still open at…, or closed since… / was open from–to. */
export function statusBlock(r) {
  let line = "";
  if (r.status === "open") line = `✓ Still open at ${hm(r.stillOpenAt)}` + (r.confirmations > 1 ? ` · ${r.confirmations} checks` : "");
  else if (r.status === "closed" || (r.status === "stale" && !(r.offices && r.offices.length))) {
    line = r.closedSince ? `since ${hm(r.closedSince)}` : "no offices listed";
    if (r.lastOpen) line += ` · was open ${hm(r.lastOpen.from)}–${hm(r.lastOpen.to)}`;
  } else if (r.status === "stale") line = `still open at ${hm(r.stillOpenAt || r.lastChecked)} – check again`;
  return el("div", { class: "status-block" }, statusBadge(r), line ? el("div", { class: "hint", testid: "status-line" }, line) : null);
}

export function watchButton(r, onChange) {
  return el("button", {
    type: "button",
    class: "btn small watch" + (r.watched ? " on" : ""),
    "aria-pressed": String(!!r.watched),
    title: r.watched ? "You get alerts for this. Click to stop." : "Get an alert when offices open for this",
    testid: "row-watch",
    onclick: async () => {
      await post("/citamate/watches", { province: r.province, tramite: r.tramite, on: !r.watched });
      toast(r.watched ? "Alerts off for " + r.province : "You'll be alerted when offices open: " + r.province, "ok");
      onChange();
    },
  }, el("span", { "aria-hidden": "true" }, r.watched ? "🔔" : "🔕"), el("span", { class: "watch-text" }, r.watched ? " Watching" : " Watch"));
}

export default async function officesPage() {
  const root = el("div");
  const box = el("div");
  let items = [];

  async function load() {
    try {
      items = (await get("/citamate/check-queue")).items || [];
    } catch (e) {
      toastError(e);
      items = [];
    }
    draw();
  }

  async function check(r) {
    try {
      await post("/citamate/check-queue/claim", { province: r.province, tramite: r.tramite, entryId: r.checkEntryId });
    } catch (e) {
      toastError(e);
      return load();
    }
    window.open(`${CITA_START}#citamate-check=${encodeURIComponent(r.checkEntryId)}`, "_blank", "noopener");
    toast("Cita site opened in a new tab: press Alt+Enter on each page and solve the captcha. CitaMate stops at the office list.", "ok");
    load();
  }

  function draw() {
    box.textContent = "";
    const cols = [
      { label: "Province · trámite", class: "wrap", render: (r) => el("div", { class: "pair" }, el("strong", null, r.province), el("div", { class: "hint" }, r.tramite)) },
      { label: "Entries", class: "nowrap", render: (r) => el("div", null, String(r.entries), el("div", { class: "hint" }, r.wanted.join(", "))) },
      {
        label: "Last check",
        class: "nowrap",
        render: (r) => el("div", null, statusBlock(r), el("div", { class: "hint", title: r.lastChecked ? fmtTime(r.lastChecked) : "" }, r.lastChecked ? "checked " + ago(r.lastChecked) : "—")),
      },
      {
        label: "Offices open",
        class: "wrap",
        render: (r) => (r.status === "open" || (r.status === "stale" && r.offices.length) ? el("div", { class: "office-chips" }, r.offices.map((o) => el("span", { class: "jv-chip", title: `${o.text}\nOpen since ${hm(o.since)}, still listed at ${hm(o.stillListedAt)}` }, `${short(o.text)} · since ${hm(o.since)}`))) : ""),
      },
      { label: "Alerts", render: (r) => watchButton(r, load) },
      {
        label: "",
        class: "actions",
        render: (r) => {
          if (r.claim && !r.claim.mine) return el("span", { class: "hint", testid: "row-claimed" }, `Being checked by ${r.claim.by}…`);
          if (!r.checkEntryId) return el("span", { class: "hint", title: "The cita site asks for a client's NIE and name: a check needs one of your own entries with this province and trámite." }, "No entry of yours");
          return el("button", { type: "button", class: "btn small primary", testid: "row-check", onclick: () => check(r) }, r.claim && r.claim.mine ? "Check again" : "Check");
        },
      },
    ];
    box.append(
      table(cols, items, { testid: "offices-table", empty: "No active entries with a province and trámite. Add entries (Pending / In progress) to see what to check." }),
      el("p", { class: "hint list-foot" }, `${items.length} province + trámite pairs from everyone's Pending and In progress entries. One check covers every entry of the pair, whatever office it wants. Stalest first.`),
    );
  }

  const onAlert = () => load();
  window.addEventListener("eh:alert", onAlert);
  const timer = setInterval(() => (root.isConnected ? load() : cleanup()), 30_000);
  function cleanup() {
    clearInterval(timer);
    window.removeEventListener("eh:alert", onAlert);
  }

  root.append(
    pageHead("Offices to check", el("button", { type: "button", class: "btn", testid: "offices-refresh", onclick: () => load() }, "Refresh")),
    el("div", { class: "card how" },
      el("strong", null, "How a check works: "),
      "click Check → the cita site opens with CitaMate in office-check mode → press Alt+Enter on each page and solve the captcha → CitaMate stops at the office list without booking. Everyone watching gets an alert, and matching entries show “Office open”."),
    box,
  );
  await load();
  return root;
}
