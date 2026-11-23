// Parses one proxy per line. Accepted forms:
//   host:port
//   host:port:user:pass
//   user:pass@host:port
//   scheme://host:port   scheme://user:pass@host:port      (http, https, socks4, socks5)
// Returns { items, errors: [{ line, text, message }] }.
const SCHEMES = ["http", "https", "socks4", "socks5"];

export function parseProxyLine(line, defaultScheme = "http") {
  let s = line.trim();
  let scheme = defaultScheme;
  const m = /^([a-z0-9]+):\/\//i.exec(s);
  if (m) {
    scheme = m[1].toLowerCase();
    if (scheme === "socks") scheme = "socks5";
    if (!SCHEMES.includes(scheme)) throw new Error(`Unknown scheme "${m[1]}"`);
    s = s.slice(m[0].length).replace(/\/+$/, "");
  }
  let user = "";
  let pass = "";
  let hostPort = s;
  const at = s.lastIndexOf("@");
  if (at > -1) {
    const cred = s.slice(0, at);
    hostPort = s.slice(at + 1);
    const c = cred.indexOf(":");
    user = c > -1 ? cred.slice(0, c) : cred;
    pass = c > -1 ? cred.slice(c + 1) : "";
    try { user = decodeURIComponent(user); pass = decodeURIComponent(pass); } catch (_) { /* keep raw */ }
  }
  const parts = hostPort.split(":");
  let host, port;
  if (at > -1 || parts.length === 2) {
    if (parts.length !== 2) throw new Error("Expected host:port");
    [host, port] = parts;
  } else if (parts.length >= 4) {
    host = parts[0];
    port = parts[1];
    user = parts[2];
    pass = parts.slice(3).join(":");
  } else {
    throw new Error("Expected host:port or host:port:user:pass");
  }
  host = host.trim();
  const p = Number(port);
  if (!host) throw new Error("Missing host");
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error("Port must be 1–65535");
  return {
    name: `${host}:${p}`,
    scheme,
    host,
    port: p,
    usernameTemplate: user,
    password: pass,
    country: "",
    city: "",
    sessionStart: 1,
    sessionEnd: 1000,
  };
}

export function parseProxyList(text, defaultScheme = "http") {
  const items = [];
  const errors = [];
  String(text || "")
    .split(/\r?\n/)
    .forEach((raw, i) => {
      const line = raw.trim();
      if (!line || line.startsWith("#")) return;
      try {
        items.push(parseProxyLine(line, defaultScheme));
      } catch (e) {
        errors.push({ line: i + 1, text: line, message: e.message });
      }
    });
  return { items, errors };
}
