import type { ProxyProfile } from "../core/types";
import { BYPASS_LIST } from "../shared/config";
import { callApi } from "../shared/api";
import { apiHost } from "../core/hubdata";
import { getLocal } from "../shared/storage";

type ProxyValue = chrome.proxy.ProxyConfig;

export function getProxySettings(): Promise<chrome.types.ChromeSettingGetResultDetails> {
  return callApi("proxy.settings.get", (cb) => chrome.proxy.settings.get({ incognito: false }, cb));
}

export function setProxySettings(value: ProxyValue): Promise<void> {
  return callApi("proxy.settings.set", (cb) => chrome.proxy.settings.set({ scope: "regular", value }, () => cb()));
}

export function clearProxySettings(): Promise<void> {
  return callApi("proxy.settings.clear", (cb) => chrome.proxy.settings.clear({ scope: "regular" }, () => cb()));
}

/** Null when we may control the proxy, else a reason to show the user. */
export async function controlProblem(): Promise<string | null> {
  const { levelOfControl } = await getProxySettings();
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
 * user's sites and cookies are left alone. Best effort: a browser without
 * this API (or one that doesn't answer) just skips it. */
export async function forgetProxyLogin(profile: ProxyProfile): Promise<void> {
  if (!chrome.browsingData?.remove) return;
  const origins = [`http://${profile.host}`, `https://${profile.host}`];
  await callApi("browsingData.remove", (cb) => chrome.browsingData.remove({ origins }, { cookies: true }, () => cb()), 4000).catch(
    () => {},
  );
}

/** Hosts that must never go through the user's proxy (the ext-hub server). */
export async function directHosts(): Promise<string[]> {
  const host = apiHost((await getLocal()).apiBase);
  return host ? [host] : [];
}

export async function applyProxy(profile: ProxyProfile): Promise<void> {
  await clearProxySettings();
  await forgetProxyLogin(profile);
  await setProxySettings({
    mode: "fixed_servers",
    rules: {
      singleProxy: { scheme: profile.scheme, host: profile.host, port: profile.port },
      bypassList: [...BYPASS_LIST, ...(await directHosts())],
    },
  });
}

export async function clearProxy(): Promise<void> {
  await clearProxySettings();
}
