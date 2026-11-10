import type { ProxyProfile } from "../core/types";
import { BYPASS_LIST } from "../shared/config";

function settingsGet(): Promise<chrome.types.ChromeSettingGetResultDetails> {
  return new Promise((resolve) => chrome.proxy.settings.get({ incognito: false }, resolve));
}

/** Null when we may control the proxy, else a reason to show the user. */
export async function controlProblem(): Promise<string | null> {
  const { levelOfControl } = await settingsGet();
  if (levelOfControl === "controlled_by_other_extensions") {
    return "Another extension controls the proxy";
  }
  if (levelOfControl === "not_controllable") {
    return "Proxy is locked by browser policy";
  }
  return null;
}

/** Chrome remembers a proxy's login (per host:port) and keeps its connections
 * open, so after a username or session change it would keep using the old
 * login and the old exit IP. Clearing the proxy host's site data also clears
 * the HTTP auth cache and closes open connections, which makes Chrome ask
 * for the login again. Only the proxy's own host is targeted, so the
 * user's sites and cookies are left alone. */
export async function forgetProxyLogin(profile: ProxyProfile): Promise<void> {
  const origins = [`http://${profile.host}`, `https://${profile.host}`];
  await chrome.browsingData.remove({ origins }, { cookies: true });
}

export async function applyProxy(profile: ProxyProfile): Promise<void> {
  await chrome.proxy.settings.clear({ scope: "regular" });
  await forgetProxyLogin(profile);
  await chrome.proxy.settings.set({
    scope: "regular",
    value: {
      mode: "fixed_servers",
      rules: {
        singleProxy: { scheme: profile.scheme, host: profile.host, port: profile.port },
        bypassList: BYPASS_LIST,
      },
    },
  });
}

export async function clearProxy(): Promise<void> {
  await chrome.proxy.settings.clear({ scope: "regular" });
}
