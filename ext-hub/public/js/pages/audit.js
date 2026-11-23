import { get, qs } from "../api.js";
import { el, table, toastError, fmtTime } from "../ui.js";
import { pageHead } from "../state.js";
import { jsonInline } from "../jsonview.js";

const PAGE = 100;

export default async function auditPage() {
  const root = el("div");
  const listBox = el("div");
  const items = [];
  let done = false;
  const more = el("button", { type: "button", class: "btn", testid: "audit-more", onclick: () => loadMore() }, "Load older");

  function draw() {
    listBox.textContent = "";
    listBox.append(
      table(
        [
          { label: "Time", render: (r) => fmtTime(r.t) },
          { label: "Who", render: (r) => r.actorName || "system" },
          { label: "Action", render: (r) => el("span", { class: "mono" }, r.action) },
          { label: "Target", render: (r) => r.target, class: "wrap" },
          { label: "Detail", render: (r) => jsonInline(r.detail), class: "wrap" },
          { label: "IP", render: (r) => r.ip },
        ],
        items,
        { testid: "audit-table", empty: "No audit records." },
      ),
    );
    more.hidden = done;
  }

  async function loadMore() {
    more.disabled = true;
    try {
      const before = items.length ? items[items.length - 1].id : "";
      const r = await get("/admin/audit" + qs({ limit: PAGE, before }));
      const got = r.items || [];
      items.push(...got);
      if (got.length < PAGE) done = true;
    } catch (e) { toastError(e); }
    more.disabled = false;
    draw();
  }

  root.append(pageHead("Audit log"), el("p", { class: "hint" }, "Sign-ins, changes to users, access, settings and data. Newest first."), listBox, el("div", { class: "toolbar" }, more));
  await loadMore();
  return root;
}
