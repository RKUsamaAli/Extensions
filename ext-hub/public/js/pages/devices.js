import { get, del, qs } from "../api.js";
import { el, table, toast, toastError, confirmDialog, fmtTime, ago, badge } from "../ui.js";
import { ownerParam, ownerSelect, pageHead, showOwner, extName } from "../state.js";

export default async function devicesPage() {
  const root = el("div");
  const listBox = el("div");
  async function load() {
    let items = [];
    try {
      items = (await get("/devices" + qs({ owner: ownerParam() }))).items || [];
    } catch (e) { toastError(e); }
    const cols = [
      { label: "Device", render: (r) => el("strong", null, r.name || "Unnamed device") },
      { label: "Extension", render: (r) => extName(r.ext) },
      { label: "Version", render: (r) => r.version },
      { label: "Last seen", render: (r) => el("span", { title: fmtTime(r.lastSeenAt) }, ago(r.lastSeenAt)) },
      { label: "Added", render: (r) => fmtTime(r.createdAt) },
      { label: "Status", render: (r) => (r.revoked ? badge("Removed", "bad") : badge("Active", "ok")) },
    ];
    if (showOwner()) cols.push({ label: "Owner", render: (r) => r.ownerName });
    cols.push({
      label: "",
      class: "actions",
      render: (r) =>
        r.revoked
          ? ""
          : el("button", {
              type: "button",
              class: "btn small danger",
              testid: "row-revoke",
              onclick: async () => {
                if (!(await confirmDialog(`Remove "${r.name || "this device"}"? It is signed out at once and frees a device slot.`, { okLabel: "Remove" }))) return;
                try {
                  await del("/devices/" + encodeURIComponent(r.id));
                  toast("Device removed.", "ok");
                  load();
                } catch (e) { toastError(e); }
              },
            }, "Remove"),
    });
    listBox.textContent = "";
    listBox.append(table(cols, items, { testid: "devices-table", empty: "No devices yet. A device appears here after you sign in to an extension." }));
  }
  root.append(
    pageHead("Devices", ownerSelect(load)),
    el("p", { class: "hint" }, "Every browser where you signed in to CitaMate or RelaySwitch. Your access allows a limited number of devices per extension: remove old ones to free a slot."),
    listBox,
  );
  await load();
  return root;
}
