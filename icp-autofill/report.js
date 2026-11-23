// Records → Entry reports: an overview of every entry, and a full report for one.
// Data from the CitaMate server (window.CM).
window.CM.ready.then(() => {
  "use strict";
  const CM = window.CM;
  const { el, fmt, ago, belongs, pill, downloadCsv, kindLabel, LABELS } = window.CF;
  const $ = (id) => document.getElementById(id);
  let entries = [];
  let logs = [];
  let sightings = [];
  let current = ""; // selected entry id

  const short = (s) => String(s || "").split(",")[0].trim();
  const isOutcome = (l) => l.action === "Result" || l.action === "Page" || l.action === "Site alert" || l.action === "Office check" || l.action === "Offices";
  const completedCheck = (l) => l.kind === "check" && l.page === "Office" && l.action === "Office check" && !/^Stopped/.test(l.detail || "");

  function statsFor(list) {
    return {
      booked: list.filter((l) => l.status === "done").length,
      moved: list.filter((l) => l.action === "Result" && l.status === "ok").length,
      failed: list.filter((l) => l.status === "fail").length,
      stuck: list.filter((l) => l.status === "stuck").length,
      waits: list.filter((l) => l.status === "wait").length,
      checks: list.filter(completedCheck).length,
      actions: list.filter((l) => l.action === "Fill" || l.action === "Fill & Next" || l.action === "Office check").length,
    };
  }

  // Strip the variable parts so the same failure groups together.
  function reason(l) {
    let d = String(l.detail || "");
    d = d.replace(/^Back on [^–]+ after [^–]+ – /, "").replace(/^Still on [^–]+ – /, "Stuck: ");
    d = d.replace(/^[^:→]+ → [^:]+: /, "").replace(/\(\d+(\.\d+)?s\)/g, "").replace(/\d+s after pressing/, "after pressing");
    return d.trim() || "(no message)";
  }

  // ---------- entry selector ----------
  function renderSelect() {
    const sel = $("repEntry");
    sel.textContent = "";
    sel.append(el("option", { value: "", text: "All entries – overview" }));
    entries.forEach((e) => sel.append(el("option", { value: e.id, text: e.label })));
    sel.value = entries.some((e) => e.id === current) ? current : "";
  }

  $("repEntry").addEventListener("change", () => {
    location.hash = $("repEntry").value ? "records/entry/" + $("repEntry").value : "records";
  });

  // ---------- overview ----------
  function renderOverview() {
    const rows = entries.map((e) => {
      const mine = logs.filter((l) => belongs(l, e));
      const s = statsFor(mine);
      const lastOutcome = [...mine].reverse().find(isOutcome);
      const last = mine[mine.length - 1];
      return el(
        "tr",
        { class: "clickable", onclick: () => (location.hash = "records/entry/" + e.id) },
        el("td", { class: "entrycell" }, el("b", { text: e.label }), el("div", { class: "msg", text: [e.provinceText, short(e.tramiteText)].filter(Boolean).join(" · "), title: e.tramiteText || null })),
        el("td", { class: "num", text: String(s.booked) }),
        el("td", { class: "num", text: String(s.moved) }),
        el("td", { class: "num", text: String(s.failed) }),
        el("td", { class: "num", text: String(s.stuck) }),
        el("td", { class: "num", text: String(s.checks) }),
        el("td", { class: "lastres" }, lastOutcome ? [pill(lastOutcome.status), " ", lastOutcome.detail] : el("span", { class: "msg", text: "—" })),
        el("td", { text: last ? ago(last.t) : "—", title: last ? fmt(last.t) : null }),
        el("td", {}, el("button", { class: "ghost small", text: "Open report" })),
      );
    });
    $("repRows").replaceChildren(...rows);
    $("repEmpty").hidden = entries.length > 0;
  }

  // ---------- one entry ----------
  function renderDetail(e) {
    const mine = logs.filter((l) => belongs(l, e));
    const s = statsFor(mine);
    const first = mine[0];
    const last = mine[mine.length - 1];

    $("repMeta").replaceChildren(
      el("span", {}, "Document ", el("b", { text: e.docType + " " + e.docNumber })),
      el("span", {}, "Province ", el("b", { text: e.provinceText || "—" })),
      el("span", {}, "Trámite ", el("b", { text: short(e.tramiteText) || "—", title: e.tramiteText || null })),
      el("span", {}, "Office ", el("b", { text: short(e.officeText) || (e.province ? "Any" : "—") })),
      el("span", {}, "Active ", el("b", { text: first ? fmt(first.t) + " → " + ago(last.t) : "never" })),
      el("a", { href: "#entries", text: "Edit entry" }),
    );

    const tile = (n, label, cls) => el("div", { class: "stat " + (cls || "") }, el("b", { text: String(n) }), el("span", { text: label }));
    $("repStats").replaceChildren(
      tile(s.actions, "Button presses"),
      tile(s.moved, "Pages moved", "ok"),
      tile(s.booked, "Booked", "ok"),
      tile(s.failed, "Failed", s.failed ? "fail" : ""),
      tile(s.stuck, "Stuck", s.stuck ? "warn" : ""),
      tile(s.waits, "Captcha waits"),
      tile(s.checks, "Office checks"),
    );

    // Where it fails: group failures + stuck by page and reason.
    const groups = new Map();
    mine
      .filter((l) => l.status === "fail" || l.status === "stuck")
      .forEach((l) => {
        const k = (l.page || "—") + "|" + reason(l);
        const g = groups.get(k) || { page: l.page || "—", reason: reason(l), n: 0, last: 0, status: l.status };
        g.n++;
        g.last = Math.max(g.last, l.t);
        groups.set(k, g);
      });
    const fails = [...groups.values()].sort((a, b) => b.n - a.n || b.last - a.last);
    $("repFails").replaceChildren(
      ...fails.map((g) =>
        el("tr", {}, el("td", { text: g.page }), el("td", { class: "wrap" }, pill(g.status), " ", g.reason), el("td", { class: "num", text: String(g.n) }), el("td", { text: ago(g.last), title: fmt(g.last) })),
      ),
    );
    $("repFailsEmpty").hidden = fails.length > 0;

    // Offices seen during this entry's visits to the office page.
    const seen = sightings.filter((c) => belongs(c, e));
    const offMap = new Map();
    seen.forEach((c) =>
      (c.offices || []).forEach((o) => {
        const r = offMap.get(o.text) || { text: o.text, n: 0, last: 0, mine: o.value === e.office };
        r.n++;
        r.last = Math.max(r.last, c.t);
        offMap.set(o.text, r);
      }),
    );
    const offs = [...offMap.values()].sort((a, b) => b.mine - a.mine || b.n - a.n);
    $("repOffices").replaceChildren(
      ...offs.map((r) =>
        el(
          "tr",
          {},
          el("td", { class: "wrap", title: r.text }, el(r.mine ? "b" : "span", { text: short(r.text) + (r.mine ? " (your office)" : "") })),
          el("td", { class: "num", text: r.n + " / " + seen.length }),
          el("td", { text: ago(r.last), title: fmt(r.last) }),
        ),
      ),
    );
    $("repOfficesEmpty").hidden = offs.length > 0;

    // Full history, newest first.
    $("repTimeline").replaceChildren(
      ...[...mine].reverse().slice(0, 400).map((l) =>
        el(
          "li",
          {},
          el("time", { text: fmt(l.t) }),
          el("span", {}, pill(l.status)),
          el("span", { class: "what" }, el("b", { text: [l.page, l.action].filter(Boolean).join(" · ") }), " — ", l.detail, el("span", { text: l.kind === "check" ? "  (office check)" : "" })),
        ),
      ),
    );
    $("repTimelineEmpty").hidden = mine.length > 0;
  }

  $("repCsv").addEventListener("click", () => {
    const e = entries.find((x) => x.id === current);
    if (!e) return;
    const rows = logs.filter((l) => belongs(l, e)).map((l) => [fmt(l.t), LABELS[l.status] || l.status, kindLabel(l.kind), l.page, l.action, l.detail, l.url]);
    downloadCsv("citamate-" + e.label.replace(/[^\w-]+/g, "_") + ".csv", ["Time", "Result", "Type", "Page", "Action", "Details", "URL"], rows);
  });

  // "Clear this entry's log" was removed: the server API only clears a whole log
  // (Records → Activity log / Office availability).

  function render() {
    renderSelect();
    const e = entries.find((x) => x.id === current);
    $("repOverview").hidden = !!e;
    $("repDetail").hidden = !e;
    if (e) renderDetail(e);
    else renderOverview();
  }

  window.addEventListener("cf:route", (ev) => {
    current = (ev.detail && ev.detail.entryId) || "";
    render();
  });

  CM.on(() => {
    entries = CM.data.entries;
    logs = CM.data.logs;
    sightings = CM.data.sightings;
    render();
  });

  entries = CM.data.entries;
  logs = CM.data.logs;
  sightings = CM.data.sightings;
  current = (window.CF_route && window.CF_route().entryId) || "";
  render();
});
