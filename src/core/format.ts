/** Human duration: 640 ms · 1.4 s · 12 s · 2 min 5 s · 1 h 3 min · 2 d 4 h */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "–";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1).replace(/\.0$/, "")} s`;
  if (s < 60) return `${Math.round(s)} s`;
  const units: [string, number][] = [["d", 86400], ["h", 3600], ["min", 60], ["s", 1]];
  let rest = Math.round(s);
  const parts: string[] = [];
  for (const [label, size] of units) {
    if (rest >= size) {
      parts.push(`${Math.floor(rest / size)} ${label}`);
      rest %= size;
    }
    if (parts.length === 2) break;
  }
  // Two units are enough ("1 h 3 min", not "1 h 3 min 20 s"). A zero second
  // unit is dropped: "2 min", "1 h".
  return parts.join(" ");
}

/** "just now", "5 min ago", "3 h ago", "2 d ago" */
export function formatAgo(t: number | null | undefined, now = Date.now()): string {
  if (!t) return "never";
  const diff = now - t;
  if (diff < 45_000) return "just now";
  return `${formatDuration(diff).split(" ").slice(0, 2).join(" ")} ago`;
}
