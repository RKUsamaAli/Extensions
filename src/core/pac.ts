import type { ProxyProfile } from "./types";

/** PAC directive for one proxy. */
export function pacTarget(p: Pick<ProxyProfile, "scheme" | "host" | "port">): string {
  const kind = p.scheme === "https" ? "HTTPS" : p.scheme === "socks5" ? "SOCKS5" : p.scheme === "socks4" ? "SOCKS" : "PROXY";
  return `${kind} ${p.host}:${p.port}`;
}

export const TEST_MARK = "rs_test=";

/**
 * PAC for a test run: a request whose URL carries `rs_test=<id>` goes through
 * that proxy only (no DIRECT fallback, so a dead proxy really fails). All other
 * traffic keeps using `fallback` (the active proxy, or DIRECT when off).
 * Chrome passes the full URL to PAC for http:// requests, which is why the
 * test URL is plain http.
 */
export function buildTestPac(profiles: ProxyProfile[], fallback: string): string {
  const map: Record<string, string> = {};
  for (const p of profiles) map[p.id] = pacTarget(p);
  return `var MAP = ${JSON.stringify(map)};
var FALLBACK = ${JSON.stringify(fallback)};
function FindProxyForURL(url, host) {
  var i = url.indexOf(${JSON.stringify(TEST_MARK)});
  if (i >= 0) {
    var id = url.substring(i + ${TEST_MARK.length}).split("&")[0];
    if (Object.prototype.hasOwnProperty.call(MAP, id)) return MAP[id];
    return "DIRECT";
  }
  if (isPlainHostName(host) || host === "localhost" || shExpMatch(host, "127.*") ||
      isInNet(host, "10.0.0.0", "255.0.0.0") || isInNet(host, "172.16.0.0", "255.240.0.0") ||
      isInNet(host, "192.168.0.0", "255.255.0.0")) {
    return "DIRECT";
  }
  return FALLBACK;
}`;
}

/** The test id carried in a URL, if any. */
export function testIdFromUrl(url: string): string | null {
  const i = url.indexOf(TEST_MARK);
  if (i < 0) return null;
  return url.substring(i + TEST_MARK.length).split("&")[0] || null;
}
