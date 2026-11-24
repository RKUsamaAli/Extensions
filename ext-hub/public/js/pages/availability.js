// Office availability, shared by everyone: what is open now (and since when), the history of
// each province + trámite, and a "best times to check" heatmap in the viewer's local time.
import { get } from "../api.js";
import { el, table, toastError, fmtTime, ago, badge } from "../ui.js";
import { pageHead } from "../state.js";
import { statusBlock, watchButton } from "./offices.js";

const hm = (t) => (t ? new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "");
const short = (s) => String(s || "").split(",")[0].trim();
const mins = (ms) => {
  const m = Math.max(0, Math.round(ms / 60000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** 7 x 24 grid of { checks, open } from [time, officesListed] pairs, local time. */
function heat(history) {
  const g = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ checks: 0, open: 0 })));
  for (const [t, n] of history) {
    const d = new Date(t);
    const c = g[(d.getDay() + 6) % 7][d.getHours()];
    c.checks++;
    if (n > 0) c.open++;
  }
  return g;
}

function heatmap(history) {
  const g = heat(history);
  const grid = el("div", { class: "heatmap", role: "table", "aria-label": "Share of checks with offices open, by weekday and hour" });
  grid.append(el("span", { class: "hm-corner" }), ...Array.from({ length: 24 }, (_, h) => el("span", { class: "hm-h" }, h % 3 === 0 ? String(h).padStart(2, "0") : "")));
  g.forEach((row, d) => {
    grid.append(el("span", { class: "hm-d" }, DAYS[d]));
    row.forEach((c, h) => {
      const cell = el("span", { class: "hm-c" + (c.checks ? "" : " hm-none"), title: `${DAYS[d]} ${String(h).padStart(2, "0")}:00 – ${c.checks ? `${c.open} of ${c.checks} checks open` : "no checks"}` });
      if (c.checks) cell.style.setProperty("--p", String(c.open / c.checks)); // CSSOM: allowed by the CSP
      grid.append(cell);
    });
  });
  return el("div", { class: "heatmap-wrap" }, grid, el("div", { class: "hm-legend hint" }, el("span", { class: "hm-c hm-none" }), " no checks ", el("span", { class: "hm-c" }), " checked, none open ", el("span", { class: "hm-c full" }), " offices open"));
}

/** Expandable list of the latest checks of a pair. */
function history(p) {
  const d = el("details", { class: "timeline" }, el("summary", null, `${p.history.length} checks`));
  d.addEventListener("toggle", () => {
    if (!d.open || d.querySelector("ol")) return;
    d.append(el("ol", null, p.history.slice(-30).reverse().map(([t, n]) => el("li", null, el("span", { class: "mono" }, new Date(t).toLocaleString([], { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })), " ", n ? badge(`${n} open`, "ok") : badge("none", "bad")))));
  });
  return d;
}

export default async function availabilityPage() {
  const root = el("div");
  const tiles = el("div", { class: "grid summary-grid avail-tiles", testid: "availability-summary" });
  const box = el("div");
  const heatBox = el("div", { class: "card" });
  const pairSel = el("select", { "aria-label": "Heatmap for", testid: "heatmap-pair" });
  let data = { pairs: [] };
  let watched = new Set();
  const key = (p) => p.province + "\u0000" + p.tramite;

  async function load() {
    try {
      const [ov, w] = await Promise.all([get("/citamate/availability?days=30"), get("/citamate/watches")]);
      data = ov;
      watched = new Set((w.items || []).map(key));
    } catch (e) {
      toastError(e);
    }
    draw();
  }

  function draw() {
    const pairs = data.pairs.map((p) => ({ ...p, watched: watched.has(key(p)) }));
    const open = pairs.filter((p) => p.status === "open");
    tiles.textContent = "";
    const tile = (n, label, note, kind) => el("div", { class: "card stat" + (kind ? " " + kind : "") }, el("b", null, n), el("span", null, label), el("small", null, note));
    tiles.append(
      tile(String(open.length), "Open now", `seen in the last ${data.freshMinutes || 15} min`, open.length ? "good" : ""),
      tile(String(pairs.length), "Province + trámite", "checked in the last 30 days"),
      tile(String(pairs.reduce((n, p) => n + p.checks24h, 0)), "Checks today", "last 24 hours, everyone"),
      tile(String(pairs.filter((p) => p.watched).length), "Watching", "you get alerts for these"),
    );
    box.textContent = "";
    box.append(table([
      { label: "Status", render: (p) => statusBlock(p) },
      { label: "Province · trámite", class: "wrap", render: (p) => el("div", { class: "pair" }, el("strong", null, p.province), el("div", { class: "hint" }, p.tramite)) },
      {
        label: "Offices",
        class: "wrap",
        render: (p) => (p.offices.length
          ? el("ul", { class: "office-list" }, p.offices.map((o) => el("li", null, el("strong", null, short(o.text)), el("span", { class: "hint", title: `Still listed at ${hm(o.stillListedAt)}` }, ` since ${hm(o.since)}` + (p.status === "open" ? ` (${mins((o.stillListedAt || Date.now()) - o.since)})` : "")))))
          : el("span", { class: "hint" }, p.status === "never" ? "" : "None listed")),
      },
      {
        label: "Checks",
        class: "nowrap",
        render: (p) => el("div", null,
          el("div", { title: fmtTime(p.lastChecked) }, "Last " + ago(p.lastChecked)),
          el("div", { class: "hint" }, `Today ${p.open24h}/${p.checks24h} open`),
          history(p)),
      },
      { label: "Alerts", render: (p) => watchButton(p, load) },
    ], pairs, { testid: "availability-table", empty: "No office checks yet. Run one from Offices to check." }));

    const current = pairSel.value;
    pairSel.textContent = "";
    pairSel.append(el("option", { value: "" }, "All provinces and trámites"), pairs.map((p) => el("option", { value: key(p) }, `${p.province} · ${short(p.tramite).slice(0, 60)}`)));
    pairSel.value = pairs.some((p) => key(p) === current) ? current : "";
    drawHeat();
  }

  function drawHeat() {
    const sel = data.pairs.filter((p) => !pairSel.value || key(p) === pairSel.value);
    heatBox.textContent = "";
    heatBox.append(
      el("div", { class: "row space" }, el("h2", null, "Best times to check"), pairSel),
      el("p", { class: "hint" }, "Share of checks that found offices open, by weekday and hour (your local time, last 30 days). Darker = offices were open more often."),
      heatmap(sel.flatMap((p) => p.history)),
    );
  }
  pairSel.addEventListener("change", drawHeat);

  const onAlert = () => load();
  window.addEventListener("eh:alert", onAlert);
  const timer = setInterval(() => (root.isConnected ? load() : cleanup()), 60_000);
  function cleanup() {
    clearInterval(timer);
    window.removeEventListener("eh:alert", onAlert);
  }

  root.append(
    pageHead("Office availability", el("a", { class: "btn", href: "#offices" }, "Offices to check")),
    el("p", { class: "hint" }, "Shared by everyone: every office check updates this page live. “Open” means a check in the last 15 minutes listed offices. Client names are never shown here."),
    tiles,
    box,
    heatBox,
  );
  await load();
  return root;
}
