export type Scheme = "http" | "https" | "socks4" | "socks5";

export interface ProxyProfile {
  id: string;
  name: string;
  scheme: Scheme;
  host: string;
  port: number;
  /** Plain username or a template with {session}, {country}, {city}. */
  usernameTemplate: string;
  password: string;
  country: string;
  city: string;
  sessionStart: number;
  sessionEnd: number;
}

export type Status =
  | "off"
  | "connecting"
  | "connected"
  | "auth_failed"
  | "error"
  | "conflict";

export interface RuntimeState {
  enabled: boolean;
  activeProfileId: string | null;
  sessionId: number | null;
  status: Status;
  statusDetail: string;
  exitIp: string | null;
  checkedAt: number | null;
  latencyMs: number | null;
}

export interface LogEntry {
  /** Set when queued for the server, which ignores a repeated id (safe resends). */
  id?: string;
  t: number;
  level: "info" | "warn" | "error";
  event: string;
  /** Display name at the time of the event. */
  profile?: string;
  /** Lets the log be filtered per proxy. */
  profileId?: string;
  detail?: string;
}

/** One measured attempt through a proxy. */
export interface CheckResult {
  t: number;
  ok: boolean;
  /** Response time in ms, when ok. */
  ms?: number;
  ip?: string;
  error?: string;
  /** "test" = Test all / Test button, "use" = while browsing through it. */
  source: "test" | "use";
}

export interface ProxyStats {
  results: CheckResult[];
}
