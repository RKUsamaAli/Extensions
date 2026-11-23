import { IP_CHECK_TIMEOUT_MS, IP_CHECK_URL } from "../shared/config";

export interface IpResult {
  ip: string;
  latencyMs: number;
}

/** Extension fetches go through the browser's proxy, so this is the exit IP. */
export async function checkExitIp(): Promise<IpResult> {
  const started = performance.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), IP_CHECK_TIMEOUT_MS);
  try {
    const res = await fetch(IP_CHECK_URL, { cache: "no-store", signal: ctrl.signal });
    if (!res.ok) throw new Error(`IP check HTTP ${res.status}`);
    const body = (await res.json()) as { ip?: unknown };
    if (typeof body.ip !== "string") throw new Error("IP check returned no IP");
    return { ip: body.ip, latencyMs: Math.round(performance.now() - started) };
  } finally {
    clearTimeout(timer);
  }
}
