import { callApi } from "../shared/api";
import { IP_CHECK_URL } from "../shared/config";
import { getLocal } from "../shared/storage";
import { clearProxySettings, getProxySettings, setProxySettings } from "./proxy";

export interface CheckStep {
  name: string;
  ok: boolean;
  ms: number;
  detail: string;
}

async function step(name: string, fn: () => Promise<string>): Promise<CheckStep> {
  const started = performance.now();
  try {
    const detail = await fn();
    return { name, ok: true, ms: Math.round(performance.now() - started), detail };
  } catch (err) {
    return { name, ok: false, ms: Math.round(performance.now() - started), detail: err instanceof Error ? err.message : String(err) };
  }
}

const present = (fn: () => unknown) => {
  try {
    return typeof fn() === "function";
  } catch {
    return false;
  }
};

/** Tries each browser feature RelaySwitch uses and reports what happened, so
 * a problem in a particular browser shows up as one failing line. */
export async function runBrowserCheck(listenerErrors: string[]): Promise<CheckStep[]> {
  const steps: CheckStep[] = [];
  steps.push({ name: "Browser", ok: true, ms: 0, detail: navigator.userAgent });

  steps.push(await step("storage.local", async () => {
    await callApi("storage.local.set", (cb) => chrome.storage.local.set({ _check: Date.now() }, () => cb()));
    await callApi("storage.local.remove", (cb) => chrome.storage.local.remove("_check", () => cb()));
    return "read and write work";
  }));

  steps.push(await step("storage.session", async () => {
    if (!present(() => chrome.storage.session?.get)) throw new Error("missing (memory fallback is used)");
    await callApi("storage.session.get", (cb) => chrome.storage.session.get(null, cb));
    return "works";
  }));

  steps.push(await step("proxy.settings.get", async () => {
    if (!present(() => chrome.proxy?.settings?.get)) throw new Error("missing");
    const r = await getProxySettings();
    return `levelOfControl: ${r.levelOfControl ?? "(none)"} · mode: ${(r.value as { mode?: string } | undefined)?.mode ?? "(none)"}`;
  }));

  const { enabled } = await getLocal();
  if (enabled) {
    steps.push({ name: "proxy.settings.set / clear", ok: true, ms: 0, detail: "skipped while RelaySwitch is on; turn it off to test" });
  } else {
    steps.push(await step("proxy.settings.set / clear", async () => {
      if (!present(() => chrome.proxy?.settings?.set)) throw new Error("missing");
      await setProxySettings({ mode: "direct" });
      await clearProxySettings();
      return "set and clear work";
    }));
  }

  for (const name of ["onAuthRequired", "onErrorOccurred", "onCompleted"] as const) {
    const ok = present(() => chrome.webRequest?.[name]?.addListener) && !listenerErrors.includes(`webRequest.${name}`);
    steps.push({
      name: `webRequest.${name}`,
      ok,
      ms: 0,
      detail: ok ? "listener registered" : listenerErrors.includes(`webRequest.${name}`) ? "exists but refused the listener" : "missing",
    });
  }

  steps.push({
    name: "scripting (floating button)",
    ok: present(() => chrome.scripting?.registerContentScripts),
    ms: 0,
    detail: present(() => chrome.scripting?.registerContentScripts) ? "available" : "missing",
  });
  steps.push({
    name: "browsingData (login reset)",
    ok: present(() => chrome.browsingData?.remove),
    ms: 0,
    detail: present(() => chrome.browsingData?.remove) ? "available" : "missing",
  });

  steps.push(await step("Network (exit IP)", async () => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(IP_CHECK_URL, { cache: "no-store", signal: ctrl.signal });
      const body = (await res.json()) as { ip?: string };
      return `${body.ip ?? "?"}${enabled ? " (through the proxy)" : " (direct)"}`;
    } finally {
      clearTimeout(t);
    }
  }));
  return steps;
}
