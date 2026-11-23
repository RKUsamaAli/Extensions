import { get, qs } from "../api.js";
import { el, scrollTable, fmtTime } from "../ui.js";
import { pageHead } from "../state.js";
import { jsonInline } from "../jsonview.js";

const PAGE = 100;

export default async function auditPage() {
  const list = scrollTable(
    [
      { label: "Time", class: "nowrap", render: (r) => fmtTime(r.t) },
      { label: "Who", render: (r) => r.actorName || "system" },
      { label: "Action", render: (r) => el("span", { class: "mono" }, r.action) },
      { label: "Target", render: (r) => r.target, class: "wrap" },
      { label: "Detail", render: (r) => jsonInline(r.detail), class: "wrap" },
      { label: "IP", render: (r) => r.ip },
    ],
    {
      testid: "audit-table",
      empty: "No audit records.",
      // Newest first; the next page starts before the oldest row loaded so far.
      fetchPage: async (before = "") => {
        const r = await get("/admin/audit" + qs({ limit: PAGE, before }));
        const items = r.items || [];
        return { items, next: items.length === PAGE ? items[items.length - 1].id : null };
      },
    },
  );
  return el("div", null, pageHead("Audit log"), el("p", { class: "hint" }, "Sign-ins, changes to users, access, settings and data. Newest first; scroll to load older records."), list);
}
