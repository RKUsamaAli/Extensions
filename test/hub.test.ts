import { describe, expect, it, vi } from "vitest";
import { Hub, HubError, hubMessage, type HubStore, type HubTokens } from "../src/shared/hub";
import {
  apiHost,
  checksToStats,
  chunk,
  normalizeApiBase,
  profileBody,
  remapIds,
  remapLogs,
  statsToChecks,
  toProfile,
} from "../src/core/hubdata";
import { buildTestPac } from "../src/core/pac";

// ---------- helpers ----------

function memoryStore(init: Partial<HubTokens> = {}): HubStore & { data: HubTokens } {
  const data: HubTokens = {
    apiBase: "http://hub.test",
    deviceId: "dev-1",
    refreshToken: "rt-1",
    accessToken: "at-1",
    accessExpiresAt: null,
    ...init,
  };
  return {
    data,
    load: async () => ({ ...data }),
    save: async (patch) => {
      Object.assign(data, patch);
    },
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type Call = { url: string; init: RequestInit };

/** A fake fetch that answers from a list of handlers, in order, and records calls. */
function fakeFetch(answers: ((c: Call) => Response | Promise<Response>)[]) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    const next = answers.shift();
    if (!next) throw new Error(`unexpected call ${call.url}`);
    return next(call);
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

const headers = (c: Call) => c.init.headers as Record<string, string>;

// ---------- client ----------

describe("Hub.request", () => {
  it("sends the access token, client and device headers", async () => {
    const store = memoryStore();
    const f = fakeFetch([() => json(200, { items: [] })]);
    const hub = new Hub({ store, version: "0.2.0", fetch: f.fn });
    await expect(hub.get("/relayswitch/proxies")).resolves.toEqual({ items: [] });
    expect(f.calls[0]!.url).toBe("http://hub.test/api/v1/relayswitch/proxies");
    expect(headers(f.calls[0]!)).toMatchObject({
      Authorization: "Bearer at-1",
      "X-Client": "relayswitch/0.2.0",
      "X-Device-Id": "dev-1",
    });
  });

  it("refreshes an expired access token once and retries the call once", async () => {
    const store = memoryStore();
    const f = fakeFetch([
      () => json(401, { code: "access_token_expired", message: "expired" }),
      (c) => {
        expect(c.url).toBe("http://hub.test/api/v1/auth/refresh");
        expect(JSON.parse(String(c.init.body))).toEqual({ refreshToken: "rt-1" });
        return json(200, { accessToken: "at-2", accessExpiresAt: Date.now() + 600_000 });
      },
      (c) => {
        expect(headers(c).Authorization).toBe("Bearer at-2");
        return json(200, { ok: true });
      },
    ]);
    const hub = new Hub({ store, version: "0.2.0", fetch: f.fn });
    await expect(hub.post("/relayswitch/logs", { items: [] })).resolves.toEqual({ ok: true });
    expect(f.calls).toHaveLength(3);
    expect(store.data.accessToken).toBe("at-2");
  });

  it("does not retry a second time when the retry is also expired", async () => {
    const store = memoryStore();
    const f = fakeFetch([
      () => json(401, { code: "access_token_expired" }),
      () => json(200, { accessToken: "at-2", accessExpiresAt: null }),
      () => json(401, { code: "access_token_expired" }),
    ]);
    const hub = new Hub({ store, version: "0.2.0", fetch: f.fn });
    await expect(hub.get("/x")).rejects.toMatchObject({ code: "access_token_expired" });
    expect(f.calls).toHaveLength(3);
  });

  it("refreshes ahead of time when the access token is about to expire", async () => {
    const store = memoryStore({ accessExpiresAt: 1_000 });
    const f = fakeFetch([
      (c) => {
        expect(c.url).toMatch(/\/auth\/refresh$/);
        return json(200, { accessToken: "at-9", accessExpiresAt: 999_999 });
      },
      (c) => {
        expect(headers(c).Authorization).toBe("Bearer at-9");
        return json(200, {});
      },
    ]);
    const hub = new Hub({ store, version: "0.2.0", fetch: f.fn, now: () => 0 });
    await hub.get("/x");
    expect(f.calls).toHaveLength(2);
  });

  it("shares one refresh between concurrent calls", async () => {
    const store = memoryStore({ accessToken: null });
    let refreshes = 0;
    const fn = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/auth/refresh")) {
        refreshes++;
        await new Promise((r) => setTimeout(r, 5));
        return json(200, { accessToken: "at-2", accessExpiresAt: null });
      }
      return json(200, {});
    }) as unknown as typeof fetch;
    const hub = new Hub({ store, version: "0.2.0", fetch: fn });
    await Promise.all([hub.get("/a"), hub.get("/b"), hub.get("/c")]);
    expect(refreshes).toBe(1);
  });

  it.each(["subscription_expired", "account_disabled", "device_revoked", "no_entitlement", "session_expired"])(
    "%s signs out: clears tokens and notifies",
    async (code) => {
      const store = memoryStore();
      const onSignedOut = vi.fn();
      const f = fakeFetch([() => json(403, { code, message: "nope", expiresAt: 0 })]);
      const hub = new Hub({ store, version: "0.2.0", fetch: f.fn, onSignedOut });
      const err = await hub.get("/x").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HubError);
      expect((err as HubError).code).toBe(code);
      expect(store.data.refreshToken).toBeNull();
      expect(store.data.accessToken).toBeNull();
      expect(onSignedOut).toHaveBeenCalledOnce();
    },
  );

  it("treats a refused refresh token as the end of the sign-in", async () => {
    const store = memoryStore();
    const onSignedOut = vi.fn();
    const f = fakeFetch([
      () => json(401, { code: "access_token_expired" }),
      () => json(401, { code: "invalid_token" }),
    ]);
    const hub = new Hub({ store, version: "0.2.0", fetch: f.fn, onSignedOut });
    await expect(hub.get("/x")).rejects.toMatchObject({ code: "session_expired" });
    expect(store.data.refreshToken).toBeNull();
    expect(onSignedOut).toHaveBeenCalledOnce();
  });

  it("keeps the sign-in on update_required and explains it", async () => {
    const store = memoryStore();
    const onSignedOut = vi.fn();
    const f = fakeFetch([() => json(426, { code: "update_required", message: "old", minVersion: "0.3.0" })]);
    const hub = new Hub({ store, version: "0.2.0", fetch: f.fn, onSignedOut });
    const err = (await hub.get("/x").catch((e: unknown) => e)) as HubError;
    expect(err.status).toBe(426);
    expect(err.message).toBe("Please update RelaySwitch to version 0.3.0 or newer.");
    expect(err.extra).toEqual({ minVersion: "0.3.0" });
    expect(store.data.refreshToken).toBe("rt-1");
    expect(onSignedOut).not.toHaveBeenCalled();
  });

  it("maps a network failure to 'Can't reach server' without signing out", async () => {
    const store = memoryStore();
    const fn = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const hub = new Hub({ store, version: "0.2.0", fetch: fn });
    const err = (await hub.get("/x").catch((e: unknown) => e)) as HubError;
    expect(err.code).toBe("network");
    expect(err.message).toMatch(/Can't reach server/);
    expect(store.data.refreshToken).toBe("rt-1");
  });

  it("refuses to call the server while signed out", async () => {
    const f = fakeFetch([]);
    const hub = new Hub({ store: memoryStore({ refreshToken: null }), version: "0.2.0", fetch: f.fn });
    await expect(hub.get("/x")).rejects.toMatchObject({ code: "not_signed_in" });
    expect(f.calls).toHaveLength(0);
  });

  it("maps non-JSON errors by status", async () => {
    const f = fakeFetch([() => new Response("Bad gateway", { status: 502 })]);
    const hub = new Hub({ store: memoryStore(), version: "0.2.0", fetch: f.fn });
    await expect(hub.get("/x")).rejects.toMatchObject({ code: "http_502", status: 502 });
  });
});

describe("Hub.login / logout", () => {
  it("logs in as this extension and device, stores the tokens", async () => {
    const store = memoryStore({ refreshToken: null, accessToken: null });
    const f = fakeFetch([
      (c) => {
        const body = JSON.parse(String(c.init.body));
        expect(c.url).toBe("http://other.test/api/v1/auth/login");
        expect(body).toMatchObject({
          username: "ali",
          password: "secret",
          client: { kind: "extension", ext: "relayswitch", deviceId: "dev-1", version: "0.2.0" },
        });
        expect(headers(c).Authorization).toBeUndefined();
        return json(200, {
          accessToken: "at",
          accessExpiresAt: 5,
          refreshToken: "rt",
          refreshExpiresAt: 9,
          user: { id: "u1", username: "ali", email: null, role: "user" },
          entitlements: [{ ext: "relayswitch", expiresAt: null, maxDevices: 2, active: true }],
        });
      },
    ]);
    const hub = new Hub({ store, version: "0.2.0", fetch: f.fn });
    const res = await hub.login("ali", "secret", "http://other.test");
    expect(res.user.username).toBe("ali");
    expect(store.data).toMatchObject({ apiBase: "http://other.test", refreshToken: "rt", accessToken: "at", accessExpiresAt: 5 });
  });

  it("reports wrong credentials without storing anything", async () => {
    const store = memoryStore({ refreshToken: null, accessToken: null });
    const f = fakeFetch([() => json(401, { code: "invalid_credentials", message: "x" })]);
    const hub = new Hub({ store, version: "0.2.0", fetch: f.fn });
    await expect(hub.login("a", "b", "http://hub.test")).rejects.toThrow("Wrong username or password.");
    expect(store.data.refreshToken).toBeNull();
  });

  it("forgets the tokens on logout even when the server is down", async () => {
    const store = memoryStore();
    const fn = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    await new Hub({ store, version: "0.2.0", fetch: fn }).logout();
    expect(store.data.refreshToken).toBeNull();
    expect(store.data.accessToken).toBeNull();
  });
});

describe("hubMessage", () => {
  it("names the expiry date and device limit", () => {
    expect(hubMessage("subscription_expired", "", { expiresAt: Date.UTC(2026, 0, 15, 12) })).toMatch(/expired on .*2026/);
    expect(hubMessage("device_limit", "", { maxDevices: 2 })).toBe("Device limit reached (2). Ask the admin to remove a device.");
    expect(hubMessage("something_new", "Server text")).toBe("Server text");
  });
});

// ---------- data helpers ----------

const prof = (id: string, host = "1.2.3.4") => ({
  id,
  name: "",
  scheme: "http" as const,
  host,
  port: 80,
  usernameTemplate: "u",
  password: "p",
  country: "",
  city: "",
  sessionStart: 1,
  sessionEnd: 2,
});

describe("migration helpers", () => {
  it("maps old ids to new ids by position", () => {
    const ids = remapIds([prof("old-a"), prof("old-b")], [{ id: "new-a" }, { id: "new-b" }]);
    expect([...ids]).toEqual([
      ["old-a", "new-a"],
      ["old-b", "new-b"],
    ]);
  });

  it("refuses a partial create", () => {
    expect(() => remapIds([prof("a"), prof("b")], [{ id: "x" }])).toThrow(/1 of 2/);
  });

  it("turns stats into checks with new ids, oldest first, dropping unknown proxies", () => {
    const ids = new Map([["old-a", "new-a"]]);
    const checks = statsToChecks(
      {
        "old-a": { results: [{ t: 5, ok: true, ms: 100, source: "test" }, { t: 1, ok: false, error: "x", source: "use" }] },
        gone: { results: [{ t: 3, ok: true, source: "test" }] },
      },
      ids,
    );
    expect(checks).toEqual([
      { t: 1, ok: false, error: "x", source: "use", proxyId: "new-a", id: "legacy-check:old-a:1:1" },
      { t: 5, ok: true, ms: 100, source: "test", proxyId: "new-a", id: "legacy-check:old-a:5:0" },
    ]);
  });

  it("moves log proxy ids to the new ids and drops ids that no longer exist", () => {
    const ids = new Map([["old-a", "new-a"]]);
    const logs = remapLogs(
      [
        { t: 1, level: "info", event: "connect", profile: "A", profileId: "old-a" },
        { t: 2, level: "warn", event: "x", profile: "B", profileId: "gone" },
        { t: 3, level: "info", event: "test_start" },
      ],
      ids,
    );
    expect(logs).toEqual([
      { id: "legacy-log:1:0", t: 1, level: "info", event: "connect", profile: "A", profileId: "new-a" },
      { id: "legacy-log:2:1", t: 2, level: "warn", event: "x", profile: "B" },
      { id: "legacy-log:3:2", t: 3, level: "info", event: "test_start" },
    ]);
    // Same input, same ids: a retried upload is de-duplicated by the server.
    expect(remapLogs([{ t: 1, level: "info", event: "connect" }], ids)[0]!.id).toBe("legacy-log:1:0");
  });

  it("builds stats from the server shape", () => {
    expect(checksToStats({ a: { results: [{ t: 1, ok: true, source: "test" }] } })).toEqual({
      a: { results: [{ t: 1, ok: true, source: "test" }] },
    });
    expect(checksToStats(undefined)).toEqual({});
  });
});

describe("server shapes", () => {
  it("strips ownership fields and fixes types", () => {
    const item = { ...prof("x"), port: "8080" as unknown as number, ownerId: "u", ownerName: "ali", createdAt: 1, updatedAt: 2 };
    const p = toProfile(item);
    expect(p).toEqual({ ...prof("x"), port: 8080 });
    expect("ownerId" in p).toBe(false);
  });

  it("sends every field but the id", () => {
    const body = profileBody(prof("x"));
    expect("id" in body).toBe(false);
    expect(body.host).toBe("1.2.3.4");
  });

  it("chunks lists", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
    expect(() => chunk([1], 0)).toThrow();
  });
});

describe("server address", () => {
  it.each([
    ["http://localhost:4000/", "http://localhost:4000"],
    ["localhost:4000", "http://localhost:4000"],
    ["api.example.com", "https://api.example.com"],
    [" https://api.example.com/hub/ ", "https://api.example.com/hub"],
  ])("%j → %s", (input, out) => expect(normalizeApiBase(input)).toBe(out));

  it.each(["", "ftp://x.com", "https://user:pw@x.com", "http://"])("rejects %j", (input) => {
    expect(() => normalizeApiBase(input)).toThrow();
  });

  it("extracts the host for the proxy bypass", () => {
    expect(apiHost("https://api.example.com:8443/x")).toBe("api.example.com");
    expect(apiHost("not a url")).toBeNull();
  });

  it("sends the server DIRECT in the test PAC", () => {
    const pac = buildTestPac([prof("abc")], "PROXY 9.9.9.9:80", ["API.example.com"]);
    const FindProxyForURL = new Function("isPlainHostName", "shExpMatch", "isInNet", `${pac}; return FindProxyForURL;`)(
      () => false,
      () => false,
      () => false,
    ) as (u: string, h: string) => string;
    expect(FindProxyForURL("https://api.example.com/api/v1/x", "api.example.com")).toBe("DIRECT");
    expect(FindProxyForURL("https://other.com/", "other.com")).toBe("PROXY 9.9.9.9:80");
  });
});
