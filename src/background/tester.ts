import { buildTestPac, pacTarget, TEST_MARK } from "../core/pac";
import { formatDuration } from "../core/format";
import type { ProxyProfile } from "../core/types";
import { IP_CHECK_TIMEOUT_MS, TEST_URL } from "../shared/config";
import { activeProfile, getLocal, getSession, log, profiles as loadProfiles, recordResult, setSession, who } from "../shared/storage";
import { applyProxy, clearProxy, directHosts, forgetProxyLogin, setProxySettings } from "./proxy";

/**
 * Tests proxies one at a time without changing what the user browses through.
 * A temporary PAC script sends only the test request (marked rs_test=<id>)
 * through the proxy under test; everything else keeps using the active proxy,
 * or DIRECT when RelaySwitch is off. Tests run in sequence because Chrome
 * caches one login per proxy host:port, and many proxies share a gateway.
 */
export async function runTests(ids: string[] | undefined): Promise<void> {
  const current = await getSession();
  if (current.testRun?.running) throw new Error("A test is already running");

  const { enabled } = await getLocal();
  const profiles = await loadProfiles();
  const targets = ids?.length ? profiles.filter((p) => ids.includes(p.id)) : profiles;
  if (!targets.length) throw new Error("No proxies to test");

  const active = enabled ? await activeProfile() : null;
  const fallback = active ? pacTarget(active) : "DIRECT";

  await setSession({
    testRun: { running: true, done: 0, total: targets.length, currentId: null, cancelled: false, startedAt: Date.now() },
  });
  await log({ level: "info", event: "test_start", detail: `${targets.length} prox${targets.length === 1 ? "y" : "ies"}` });

  try {
    await setProxySettings({ mode: "pac_script", pacScript: { data: buildTestPac(profiles, fallback, await directHosts()), mandatory: true } });

    for (let i = 0; i < targets.length; i++) {
      const p = targets[i]!;
      const run = (await getSession()).testRun;
      if (!run || run.cancelled) break;
      await setSession({ testRun: { ...run, currentId: p.id } });
      await testOne(p);
      const after = (await getSession()).testRun;
      if (after) await setSession({ testRun: { ...after, done: i + 1 } });
    }
  } finally {
    // Put back exactly what the user had.
    const { enabled: stillOn } = await getLocal();
    const now = stillOn ? await activeProfile() : null;
    if (now) await applyProxy(now);
    else await clearProxy();
    const run = (await getSession()).testRun;
    await setSession({ testRun: run ? { ...run, running: false, currentId: null } : null });
    await log({
      level: "info",
      event: run?.cancelled ? "test_cancelled" : "test_done",
      detail: run ? `${run.done}/${run.total} tested` : undefined,
    });
  }
}

export async function cancelTests(): Promise<void> {
  const { testRun } = await getSession();
  if (testRun?.running) await setSession({ testRun: { ...testRun, cancelled: true } });
}

async function testOne(p: ProxyProfile): Promise<void> {
  // Make Chrome ask for this proxy's login again; the previous test may have
  // used the same gateway with another username.
  await forgetProxyLogin(p).catch(() => {});
  await setSession({ testAuthTries: 0 });

  const started = performance.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), IP_CHECK_TIMEOUT_MS);
  try {
    const sep = TEST_URL.includes("?") ? "&" : "?";
    const res = await fetch(`${TEST_URL}${sep}${TEST_MARK}${p.id}`, { cache: "no-store", signal: ctrl.signal });
    if (res.status === 407) throw new Error("Login failed (407)");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { ip?: unknown };
    if (typeof body.ip !== "string") throw new Error("No IP in answer");
    const ms = Math.round(performance.now() - started);
    await recordResult(p.id, { t: Date.now(), ok: true, ms, ip: body.ip, source: "test" });
    await log({ level: "info", event: "test_ok", ...who(p), detail: `${body.ip} · ${formatDuration(ms)}` });
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === "AbortError";
    const text = aborted ? `No answer in ${IP_CHECK_TIMEOUT_MS / 1000} s` : err instanceof Error ? err.message : String(err);
    const error = /Failed to fetch/i.test(text) ? "Could not connect through proxy" : text;
    await recordResult(p.id, { t: Date.now(), ok: false, error, source: "test" });
    await log({ level: "warn", event: "test_failed", ...who(p), detail: error });
  } finally {
    clearTimeout(timer);
  }
}
