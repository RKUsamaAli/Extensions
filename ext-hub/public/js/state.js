// Shared panel state + the admin "Owner" filter used by every data page.
import { el } from "./ui.js";

export const state = {
  user: null,
  entitlements: [],
  users: [], // admin only
  owner: "", // "" = me, "all", or a user id
};

export const EXTS = [
  { id: "citamate", name: "CitaMate" },
  { id: "relayswitch", name: "RelaySwitch" },
];
export const extName = (id) => (EXTS.find((e) => e.id === id) || { name: id }).name;

export const isAdmin = () => !!state.user && state.user.role === "admin";
/** Whether rows from other users are visible (show the Owner column). */
export const showOwner = () => isAdmin() && state.owner !== "";
/** Value for the ?owner= query parameter. */
export const ownerParam = () => (isAdmin() ? state.owner : "");

/** Owner select for admins (null for users). onChange re-renders the page. */
export function ownerSelect(onChange) {
  if (!isAdmin()) return null;
  const s = el("select", { "aria-label": "Owner", testid: "owner-select" });
  s.append(el("option", { value: "" }, "Me"));
  s.append(el("option", { value: "all" }, "All users"));
  for (const u of state.users) if (u.id !== state.user.id) s.append(el("option", { value: u.id }, u.username));
  s.value = state.owner;
  s.addEventListener("change", () => {
    state.owner = s.value;
    onChange();
  });
  return el("label", { class: "owner-filter" }, el("span", { class: "hint" }, "Owner"), s);
}

/** Page header with title (data-testid=page-title) and right-side actions. */
export function pageHead(title, ...actions) {
  return el("div", { class: "page-head" }, el("h1", { testid: "page-title" }, title), ...actions);
}
