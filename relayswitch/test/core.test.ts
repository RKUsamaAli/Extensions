import { describe, expect, it } from "vitest";
import { parseProxyLine } from "../src/core/parse";
import { nextSession, renderUsername, usesSession } from "../src/core/username";

describe("parseProxyLine", () => {
  it("parses host:port", () => {
    expect(parseProxyLine("1.2.3.4:8080")).toMatchObject({ scheme: "http", host: "1.2.3.4", port: 8080, username: "" });
  });
  it("parses host:port:user:pass, keeping ':' in the password", () => {
    expect(parseProxyLine("gate.example.com:7000:bob:p:ss")).toMatchObject({
      host: "gate.example.com", port: 7000, username: "bob", password: "p:ss",
    });
  });
  it("parses scheme URLs with encoded credentials", () => {
    expect(parseProxyLine("socks5://a%40b:pw@10.0.0.1:1080")).toMatchObject({
      scheme: "socks5", host: "10.0.0.1", port: 1080, username: "a@b", password: "pw",
    });
  });
  it.each(["", "host", "host:0", "host:70000", "bad host:80", "ftp://h:21", "http://h", "a:1:b"])(
    "rejects %j",
    (line) => expect(() => parseProxyLine(line)).toThrow(),
  );
});

describe("renderUsername", () => {
  it("fills tokens", () => {
    expect(renderUsername("u-{country}-{city}-s{session}", { session: 1001, country: "es", city: "madrid" }))
      .toBe("u-es-madrid-s1001");
  });
  it("leaves plain usernames alone", () => {
    expect(renderUsername("plain_user", {})).toBe("plain_user");
  });
  it("throws on unknown or empty tokens", () => {
    expect(() => renderUsername("u-{zone}", {})).toThrow(/Unknown token/);
    expect(() => renderUsername("u-{country}", { country: " " })).toThrow(/no value/);
    expect(() => renderUsername("u-{session}", { session: null })).toThrow(/no value/);
  });
  it("detects sessions", () => {
    expect(usesSession("u-{session}")).toBe(true);
    expect(usesSession("u-{country}")).toBe(false);
  });
});

describe("nextSession", () => {
  it("starts, increments and wraps", () => {
    expect(nextSession(null, 1000, 1002)).toBe(1000);
    expect(nextSession(1000, 1000, 1002)).toBe(1001);
    expect(nextSession(1002, 1000, 1002)).toBe(1000);
    expect(nextSession(5, 1000, 1002)).toBe(1000);
  });
  it("rejects a reversed range", () => {
    expect(() => nextSession(null, 10, 5)).toThrow();
  });
});

import { displayName } from "../src/core/profile";

describe("displayName", () => {
  const base = { host: "gate.example.com", port: 7000 };
  it("uses the name when set", () => {
    expect(displayName({ ...base, name: " Spain ", usernameTemplate: "bob" })).toBe("Spain");
  });
  it("falls back to the username, then host:port", () => {
    expect(displayName({ ...base, name: "", usernameTemplate: "bob-{session}" })).toBe("bob-{session}");
    expect(displayName({ ...base, name: " ", usernameTemplate: "" })).toBe("gate.example.com:7000");
  });
});

import { bulkNames, parseBulk } from "../src/core/bulk";
import { formatDuration } from "../src/core/format";
import { buildTestPac, testIdFromUrl } from "../src/core/pac";
import { scoreOf } from "../src/core/score";

describe("formatDuration", () => {
  it.each([
    [640, "640 ms"],
    [1000, "1 s"],
    [1430, "1.4 s"],
    [12_400, "12 s"],
    [125_000, "2 min 5 s"],
    [120_000, "2 min"],
    [3_780_000, "1 h 3 min"],
    [190_800_000, "2 d 5 h"],
  ])("%i ms → %s", (ms, text) => expect(formatDuration(ms)).toBe(text));
  it("handles missing values", () => expect(formatDuration(null)).toBe("–"));
});

describe("parseBulk", () => {
  const text = "# my list\n1.2.3.4:80:u:p\n\n1.2.3.4:80:u:p\nbad line\nsocks5://5.6.7.8:1080\n";
  it("parses, skips comments and duplicates, reports errors with line numbers", () => {
    const r = parseBulk(text, "http");
    expect(r.proxies.map((p) => [p.host, p.line])).toEqual([["1.2.3.4", 2], ["5.6.7.8", 6]]);
    expect(r.duplicates).toBe(1);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.line).toBe(5);
  });
  it("counts proxies already saved as duplicates", () => {
    expect(parseBulk("1.2.3.4:80:u:p", "http", new Set(["1.2.3.4:80:u"])).duplicates).toBe(1);
  });
});

describe("bulkNames", () => {
  const p = (host: string, username: string) => ({ scheme: "http" as const, host, port: 80, username, password: "" });
  it("names by server, adding the username when servers repeat", () => {
    expect(bulkNames([p("a.com", "u1"), p("b.com", "u2"), p("a.com", "u3")], "host")).toEqual([
      "a.com · u1",
      "b.com",
      "a.com · u3",
    ]);
  });
});

describe("scoreOf", () => {
  const ok = (ms: number) => ({ t: 1, ok: true, ms, source: "test" as const });
  const fail = { t: 2, ok: false, source: "test" as const };
  it("is null when never checked", () => expect(scoreOf([]).value).toBeNull());
  it("gives 100 to a fast, always-working proxy", () => expect(scoreOf([ok(200), ok(250)]).value).toBe(100));
  it("ranks slower proxies lower", () => {
    expect(scoreOf([ok(1650)]).value).toBe(85);
    expect(scoreOf([ok(4000)]).value).toBe(70);
  });
  it("penalises failures, most of all the latest one", () => {
    expect(scoreOf([ok(200), fail]).value).toBe(50); // 0.5*70 + 30 - 15
    expect(scoreOf([fail, ok(200)]).value).toBe(65);
    expect(scoreOf([fail]).value).toBe(0);
  });
});

describe("test PAC", () => {
  const prof = { id: "abc", name: "", scheme: "http" as const, host: "1.2.3.4", port: 80, usernameTemplate: "", password: "", country: "", city: "", sessionStart: 0, sessionEnd: 0 };
  it("routes marked requests to their proxy, others to the fallback", () => {
    const pac = buildTestPac([prof], "DIRECT");
    const FindProxyForURL = new Function(
      "isPlainHostName", "shExpMatch", "isInNet",
      `${pac}; return FindProxyForURL;`,
    )(() => false, () => false, () => false) as (u: string, h: string) => string;
    expect(FindProxyForURL("http://api.ipify.org/?format=json&rs_test=abc", "api.ipify.org")).toBe("PROXY 1.2.3.4:80");
    expect(FindProxyForURL("https://example.com/", "example.com")).toBe("DIRECT");
    expect(FindProxyForURL("http://x/?rs_test=zzz", "x")).toBe("DIRECT");
  });
  it("reads the test id from a URL", () => {
    expect(testIdFromUrl("http://a/?format=json&rs_test=abc&x=1")).toBe("abc");
    expect(testIdFromUrl("http://a/")).toBeNull();
  });
});
