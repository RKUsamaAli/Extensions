export interface UsernameVars {
  session?: number | null;
  country?: string;
  city?: string;
}

const TOKEN = /\{([a-z]+)\}/g;
const KNOWN = new Set(["session", "country", "city"]);

export function templateTokens(template: string): string[] {
  return [...template.matchAll(TOKEN)].map((m) => m[1] ?? "");
}

export function usesSession(template: string): boolean {
  return templateTokens(template).includes("session");
}

/** Fill a username template. Throws on unknown or empty tokens, so a bad
 * username never reaches the proxy. */
export function renderUsername(template: string, vars: UsernameVars): string {
  return template.replace(TOKEN, (_all, name: string) => {
    if (!KNOWN.has(name)) throw new Error(`Unknown token {${name}}`);
    const raw = name === "session" ? vars.session : vars[name as "country" | "city"];
    const value = raw === null || raw === undefined ? "" : String(raw).trim();
    if (!value) throw new Error(`Token {${name}} has no value`);
    return value;
  });
}

/** Next session id inside [start, end], wrapping at the end. */
export function nextSession(current: number | null, start: number, end: number): number {
  if (end < start) throw new Error("Session range end is before start");
  if (current === null || current < start || current >= end) return start;
  return current + 1;
}
