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
