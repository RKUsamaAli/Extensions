import type { Scheme } from "./types";

export interface ParsedProxy {
  scheme: Scheme;
  host: string;
  port: number;
  username: string;
  password: string;
}

const SCHEMES: Scheme[] = ["http", "https", "socks4", "socks5"];
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

export function isValidHost(host: string): boolean {
  return IPV4.test(host) || HOSTNAME.test(host);
}

export function parsePort(value: string | number): number {
  const port = typeof value === "number" ? value : Number(value.trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

/** Accepts `host:port`, `host:port:user:pass` and `scheme://user:pass@host:port`. */
export function parseProxyLine(line: string, defaultScheme: Scheme = "http"): ParsedProxy {
  const text = line.trim();
  if (!text) throw new Error("Empty line");

  if (text.includes("://")) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      throw new Error("Not a valid proxy URL");
    }
    const scheme = url.protocol.replace(":", "") as Scheme;
    if (!SCHEMES.includes(scheme)) throw new Error(`Unsupported scheme: ${scheme}`);
    if (!url.port) throw new Error("Port is required");
    const host = url.hostname;
    if (!isValidHost(host)) throw new Error(`Invalid host: ${host}`);
    return {
      scheme,
      host,
      port: parsePort(url.port),
      username: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    };
  }

  const parts = text.split(":");
  if (parts.length !== 2 && parts.length < 4) {
    throw new Error("Use host:port or host:port:user:pass");
  }
  const [host = "", port = "", username = "", ...rest] = parts;
  if (!isValidHost(host)) throw new Error(`Invalid host: ${host}`);
  return {
    scheme: defaultScheme,
    host,
    port: parsePort(port),
    username,
    // Passwords may contain ':'.
    password: rest.join(":"),
  };
}
