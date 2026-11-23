/**
 * Calls a browser extension API so it works in every browser and never hangs:
 * - works whether the browser answers with a callback or a promise
 * - rejects with chrome.runtime.lastError when the browser reports one
 * - rejects after `ms` with an error naming the call, for browsers where an
 *   API exists but never answers (Orion lists some APIs as stubs)
 */
export function callApi<T = void>(
  name: string,
  invoke: (callback: (value: T) => void) => unknown,
  ms = 5000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(
      () => done(() => reject(new Error(`The browser didn't answer ${name} within ${ms / 1000} s`))),
      ms,
    );
    const callback = (value: T) => {
      const err = chrome.runtime?.lastError;
      done(() => (err ? reject(new Error(`${name}: ${err.message ?? "failed"}`)) : resolve(value)));
    };
    try {
      const result = invoke(callback) as Promise<T> | undefined;
      if (result && typeof (result as Promise<T>).then === "function") {
        (result as Promise<T>).then(
          (v) => done(() => resolve(v)),
          (e: unknown) => done(() => reject(new Error(`${name}: ${e instanceof Error ? e.message : String(e)}`))),
        );
      }
    } catch (e) {
      done(() => reject(new Error(`${name}: ${e instanceof Error ? e.message : String(e)}`)));
    }
  });
}
