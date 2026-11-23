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
export function ownerSelect(onChange, { created = false } = {}) {
  if (!isAdmin()) return null;
  const s = el("select", { "aria-label": "Owner", testid: "owner-select" });
  s.append(el("option", { value: "" }, "Me"));
  s.append(el("option", { value: "all" }, "All users"));
  if (created) s.append(el("option", { value: "created" }, "Created by me (any owner)"));
  else if (state.owner === "created") state.owner = "all";
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

/** Owner for a new item: the user picked in the Owner filter, else the signed-in admin. */
export function defaultOwnerId() {
  const o = state.owner;
  return o && o !== "all" && o !== "created" && state.users.some((u) => u.id === o) ? o : state.user.id;
}

/**
 * Admins: "Owner" select for add / edit forms (name="ownerId"). The item then shows in that
 * user's CitaMate / RelaySwitch and panel; the admin still manages it. Users: null.
 */
export function ownerField(currentOwnerId, what = "item") {
  if (!isAdmin()) return null;
  const s = el("select", { name: "ownerId", testid: "owner-field" });
  s.append(el("option", { value: state.user.id }, `Me (${state.user.username})`));
  for (const u of state.users) if (u.id !== state.user.id) s.append(el("option", { value: u.id }, u.username + (u.role === "admin" ? " (admin)" : "")));
  s.value = currentOwnerId || defaultOwnerId();
  return el("label", { class: "wide" }, "Owner", s, el("div", { class: "hint" }, `The ${what} appears in this user's extension and panel when they sign in. You can still manage it.`));
}

/** Owner name, plus "added by …" when someone else (an admin) created it. */
export function ownerCell(r) {
  if (!r.createdBy || r.createdBy === r.ownerId || !r.createdByName) return r.ownerName;
  return el("div", null, r.ownerName, el("div", { class: "hint" }, "added by " + r.createdByName));
}
