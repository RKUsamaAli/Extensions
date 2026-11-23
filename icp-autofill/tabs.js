(() => {
  "use strict";
  // Routes: #entries, #records (entry reports), #records/entry/<id>, #records/log, #records/offices
  // (#logs and #offices are kept as aliases for older links).
  function route() {
    const h = location.hash.replace(/^#/, "");
    const parts = h.split("/");
    const tab = ["records", "logs", "offices"].includes(parts[0]) ? "records" : "entries";
    let sub = "report";
    if (parts[0] === "logs" || parts[1] === "log") sub = "log";
    if (parts[0] === "offices" || parts[1] === "offices") sub = "offices";
    return { tab, sub, entryId: parts[1] === "entry" ? decodeURIComponent(parts[2] || "") : "" };
  }

  function apply() {
    const r = route();
    document.getElementById("tab-entries").hidden = r.tab !== "entries";
    document.getElementById("tab-records").hidden = r.tab !== "records";
    document.querySelectorAll(".tab").forEach((a) => a.classList.toggle("active", a.dataset.tab === r.tab));
    document.getElementById("entryActions").style.visibility = r.tab === "entries" ? "visible" : "hidden";
    ["report", "log", "offices"].forEach((s) => (document.getElementById("sub-" + s).hidden = r.sub !== s));
    document.querySelectorAll(".subnav a").forEach((a) => a.classList.toggle("active", a.dataset.sub === r.sub));
    window.dispatchEvent(new CustomEvent("cf:route", { detail: r }));
    window.scrollTo(0, 0);
  }

  window.CF_route = route;
  window.addEventListener("hashchange", apply);
  apply();
})();
