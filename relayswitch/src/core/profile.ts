import type { ProxyProfile } from "./types";

/** Name shown everywhere: the user's name, else the username, else host:port. */
export function displayName(p: Pick<ProxyProfile, "name" | "usernameTemplate" | "host" | "port">): string {
  return p.name.trim() || p.usernameTemplate.trim() || `${p.host}:${p.port}`;
}
