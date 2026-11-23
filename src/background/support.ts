/**
 * Which browser features RelaySwitch can use here. Chrome, Edge, Brave and
 * Arc have all of them; WebKit-based browsers such as Orion implement only
 * part of the extension API, and some have no proxy API at all.
 */
export interface Support {
  /** Proxy on/off is possible at all. */
  canProxy: boolean;
  /** Names of missing features, for the message shown to the user. */
  missing: string[];
  /** Features that are missing but only disable an extra. */
  limited: string[];
}

const has = (fn: () => unknown): boolean => {
  try {
    return Boolean(fn());
  } catch {
    return false;
  }
};

export function detectSupport(): Support {
  const required: [string, () => unknown][] = [
    ["proxy settings (chrome.proxy)", () => chrome.proxy?.settings?.set],
    ["proxy login (webRequest.onAuthRequired)", () => chrome.webRequest?.onAuthRequired?.addListener],
  ];
  const optional: [string, () => unknown][] = [
    ["proxy error events (webRequest)", () => chrome.webRequest?.onErrorOccurred?.addListener],
    ["floating button (scripting)", () => chrome.scripting?.registerContentScripts],
    ["login reset on switch (browsingData)", () => chrome.browsingData?.remove],
    ["session storage (storage.session)", () => chrome.storage?.session?.get],
  ];
  const missing = required.filter(([, f]) => !has(f)).map(([n]) => n);
  const limited = optional.filter(([, f]) => !has(f)).map(([n]) => n);
  return { canProxy: missing.length === 0, missing, limited };
}

/** Add an event listener only if this browser has the event; never throw, so
 * one missing API can't stop the whole service worker from starting. */
export function safeListen(name: string, add: () => void, onMissing: (name: string) => void): void {
  try {
    add();
  } catch {
    onMissing(name);
  }
}
