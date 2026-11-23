// Client for the ext-hub server (see ext-hub/docs/API.md). Used only by the
// background worker. Storage and fetch are injected so it can be unit-tested.

export const EXT = "relayswitch";

export interface HubUser {
  id: string;
  username: string;
  email: string | null;
  role: "admin" | "user";
}

export interface HubEntitlement {
  ext: string;
  expiresAt: number | null;
  maxDevices: number;
  active: boolean;
}

export interface Bootstrap {
  user: HubUser;
  entitlement: HubEntitlement | null;
  minVersion: string | null;
  enabled: boolean;
  catalogVersion: number | null;
  siteConfig: Record<string, unknown>;
  serverTime: number;
}

/** What the hub client keeps between calls. */
export interface HubTokens {
  apiBase: string;
  deviceId: string;
  refreshToken: string | null;
  accessToken: string | null;
  accessExpiresAt: number | null;
}

export interface HubStore {
  load(): Promise<HubTokens>;
  save(patch: Partial<HubTokens>): Promise<void>;
}

/** Error codes after which this install is no longer signed in. */
export const SIGN_OUT_CODES = new Set([
  "not_signed_in",
  "session_expired",
  "subscription_expired",
  "account_disabled",
  "account_pending",
  "device_revoked",
  "device_limit",
  "no_entitlement",
]);

export class HubError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "HubError";
  }
  /** True when the server says this sign-in is over. */
  get signsOut(): boolean {
    return SIGN_OUT_CODES.has(this.code);
  }
}

const date = (ms: unknown) =>
  typeof ms === "number" ? new Date(ms).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" }) : "";

/** The text to show the user for a server error. */
export function hubMessage(code: string, serverMessage: string, extra: Record<string, unknown> = {}): string {
  switch (code) {
    case "network":
      return "Can't reach server. Check your internet connection and the server address.";
    case "invalid_credentials":
      return "Wrong username or password.";
    case "access_token_expired":
    case "session_expired":
    case "not_signed_in":
      return "Your sign-in has ended. Please sign in again.";
    case "account_disabled":
      return "Your account is disabled. Contact the admin.";
    case "account_pending":
      return "Your account is waiting for admin approval.";
    case "no_entitlement":
      return "Your account has no access to RelaySwitch. Contact the admin.";
    case "subscription_expired":
      return extra.expiresAt ? `Your RelaySwitch access expired on ${date(extra.expiresAt)}. Contact the admin.` : "Your RelaySwitch access has expired. Contact the admin.";
    case "device_limit":
      return `Device limit reached${typeof extra.maxDevices === "number" ? ` (${extra.maxDevices})` : ""}. Ask the admin to remove a device.`;
    case "device_revoked":
      return "This device was removed from your account. Sign in again.";
    case "update_required":
      return `Please update RelaySwitch${extra.minVersion ? ` to version ${String(extra.minVersion)} or newer` : ""}.`;
    case "ext_disabled":
      return "RelaySwitch is switched off by the admin right now.";
    case "too_many_requests":
      return `Too many attempts. Try again${typeof extra.retryAfter === "number" ? ` in ${extra.retryAfter} s` : " later"}.`;
    default:
      return serverMessage || `Server error (${code})`;
  }
}

export interface HubOptions {
  store: HubStore;
  version: string;
  fetch?: typeof fetch;
  /** Called once when the server ends this sign-in (after tokens are cleared). */
  onSignedOut?: (err: HubError) => void | Promise<void>;
  /** Request timeout in ms. */
  timeoutMs?: number;
  now?: () => number;
}

export interface LoginResult {
  user: HubUser;
  entitlements: HubEntitlement[];
}

type Method = "GET" | "POST" | "PUT" | "DELETE";

export class Hub {
  private refreshing: Promise<void> | null = null;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly o: HubOptions) {
    this.fetchFn = o.fetch ?? ((...args) => fetch(...args));
    this.now = o.now ?? Date.now;
  }

  async signedIn(): Promise<boolean> {
    return !!(await this.o.store.load()).refreshToken;
  }

  /** Signs in for this extension. Throws HubError. */
  async login(username: string, password: string, apiBase: string): Promise<LoginResult> {
    await this.o.store.save({ apiBase });
    const t = await this.o.store.load();
    const body = {
      username,
      password,
      client: { kind: "extension", ext: EXT, deviceId: t.deviceId, deviceName: deviceName(), version: this.o.version },
    };
    const res = await this.raw("POST", "/auth/login", body, null);
    const data = res as { accessToken: string; accessExpiresAt: number; refreshToken: string; user: HubUser; entitlements: HubEntitlement[] };
    if (!data?.refreshToken || !data.accessToken) throw new HubError("bad_response", "The server sent an unexpected answer", 200);
    await this.o.store.save({
      refreshToken: data.refreshToken,
      accessToken: data.accessToken,
      accessExpiresAt: data.accessExpiresAt ?? null,
    });
    return { user: data.user, entitlements: data.entitlements ?? [] };
  }

  /** Ends the sign-in on the server (best effort) and forgets the tokens. */
  async logout(): Promise<void> {
    const t = await this.o.store.load();
    if (t.accessToken) await this.raw("POST", "/auth/logout", {}, t.accessToken).catch(() => {});
    await this.clearTokens();
  }

  async clearTokens(): Promise<void> {
    await this.o.store.save({ refreshToken: null, accessToken: null, accessExpiresAt: null });
  }

  /** An authenticated call. Refreshes an expired access token once and retries once. */
  async request<T = unknown>(method: Method, path: string, body?: unknown): Promise<T> {
    let t = await this.o.store.load();
    if (!t.refreshToken) throw new HubError("not_signed_in", hubMessage("not_signed_in", ""), 401);
    // Refresh ahead of time when the token is missing or about to expire.
    if (!t.accessToken || (t.accessExpiresAt !== null && t.accessExpiresAt - this.now() < 15_000)) {
      await this.refresh();
      t = await this.o.store.load();
    }
    try {
      return (await this.raw(method, path, body, t.accessToken)) as T;
    } catch (err) {
      if (!(err instanceof HubError) || err.code !== "access_token_expired") return this.fail(err);
    }
    await this.refresh();
    t = await this.o.store.load();
    try {
      return (await this.raw(method, path, body, t.accessToken)) as T;
    } catch (err) {
      return this.fail(err);
    }
  }

  get<T = unknown>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }
  post<T = unknown>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }
  put<T = unknown>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PUT", path, body);
  }
  del<T = unknown>(path: string): Promise<T> {
    return this.request<T>("DELETE", path);
  }

  /** New access token from the refresh token. Concurrent callers share one refresh. */
  refresh(): Promise<void> {
    if (!this.refreshing) {
      this.refreshing = this.doRefresh().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    const t = await this.o.store.load();
    if (!t.refreshToken) throw new HubError("not_signed_in", hubMessage("not_signed_in", ""), 401);
    try {
      const data = (await this.raw("POST", "/auth/refresh", { refreshToken: t.refreshToken }, null)) as {
        accessToken: string;
        accessExpiresAt: number;
      };
      await this.o.store.save({ accessToken: data.accessToken, accessExpiresAt: data.accessExpiresAt ?? null });
    } catch (err) {
      // A refresh that fails with 401 means the refresh token is no good.
      if (err instanceof HubError && err.status === 401 && !err.signsOut) {
        return this.fail(new HubError("session_expired", hubMessage("session_expired", ""), 401));
      }
      return this.fail(err);
    }
  }

  /** Sign-out errors clear the tokens and notify; everything is rethrown. */
  private async fail(err: unknown): Promise<never> {
    if (err instanceof HubError && err.signsOut) {
      await this.clearTokens();
      await this.o.onSignedOut?.(err);
    }
    throw err;
  }

  /** One HTTP call; maps every failure to a HubError. */
  private async raw(method: Method, path: string, body: unknown, accessToken: string | null): Promise<unknown> {
    const t = await this.o.store.load();
    const headers: Record<string, string> = {
      Accept: "application/json",
      "X-Client": `${EXT}/${this.o.version}`,
      "X-Device-Id": t.deviceId,
    };
    if (body !== undefined && method !== "GET") headers["Content-Type"] = "application/json";
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.o.timeoutMs ?? 20_000);
    let res: Response;
    try {
      res = await this.fetchFn(`${t.apiBase}/api/v1${path}`, {
        method,
        headers,
        body: body !== undefined && method !== "GET" ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
        cache: "no-store",
        credentials: "omit",
      });
    } catch {
      throw new HubError("network", hubMessage("network", ""), 0);
    } finally {
      clearTimeout(timer);
    }
    let data: Record<string, unknown> | null = null;
    const text = await res.text().catch(() => "");
    if (text) {
      try {
        data = JSON.parse(text) as Record<string, unknown>;
      } catch {
        data = null;
      }
    }
    if (res.ok) return data ?? {};
    const code = typeof data?.code === "string" ? data.code : res.status === 401 ? "not_signed_in" : `http_${res.status}`;
    const { code: _c, message, ...extra } = data ?? {};
    throw new HubError(code, hubMessage(code, typeof message === "string" ? message : `HTTP ${res.status}`, extra), res.status, extra);
  }
}

function deviceName(): string {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Chrome\//.test(ua) ? "Chrome" : "Browser";
  const os = /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /Linux/.test(ua) ? "Linux" : /iPhone|iPad/.test(ua) ? "iOS" : "";
  return os ? `${browser} on ${os}` : browser;
}
