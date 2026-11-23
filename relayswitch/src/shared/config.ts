export const IP_CHECK_URL = "https://api.ipify.org?format=json";
export const IP_CHECK_TIMEOUT_MS = 10_000;
export const MAX_AUTH_FAILURES = 3;
export const LOG_LIMIT = 2000;
export const TEST_URL = "http://api.ipify.org/?format=json";
export const BYPASS_LIST = [
  "localhost",
  "127.0.0.1",
  "::1",
  "<local>",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
];

/** ext-hub server used until the user types another address on the sign-in form. */
export const DEFAULT_API_BASE = "http://localhost:4000";
/** Logs and check results are sent to the server in batches this often. */
export const FLUSH_MS = 5_000;
/** Cached server data older than this is reloaded when a page asks for it. */
export const STALE_MS = 30_000;
/** API batch limits (see ext-hub docs/API.md). */
export const MAX_BATCH = 500;
export const MAX_BULK = 1000;
