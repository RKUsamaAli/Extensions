// On-page RelaySwitch button. Lives in a closed shadow root so the page can't
// read or restyle it, and ignores synthetic (page-generated) events.
import ICON_SVG from "../../static/brand/icon.svg";
import { scoreBand } from "../core/score";
import type { FabPos, MenuReply, MenuState, PageMessage } from "../shared/messages";

declare global {
  interface Window {
    __relayswitchFab?: boolean;
  }
}

function mount(): void {
  const host = document.createElement("relayswitch-fab");
  host.style.cssText = "all: initial; position: fixed; z-index: 2147483646;";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `<style>${CSS}</style>
    <button class="fab" part="fab" aria-label="RelaySwitch: switch proxy" aria-haspopup="menu" aria-expanded="false">
      ${ICON}<span class="dot"></span>
    </button>
    <div class="menu" role="menu" hidden>
      <div class="head"><strong>RelaySwitch</strong><span class="ip"></span></div>
      <input class="search" type="search" placeholder="Search proxies" aria-label="Search proxies" hidden>
      <div class="loading" hidden><span class="spin"></span><span class="loading-text">Loading…</span></div>
      <div class="items"></div>
      <div class="nomatch" hidden>No matching proxies</div>
      <div class="err" hidden></div>
    </div>`;
  document.documentElement.append(host);

  const fab = root.querySelector<HTMLButtonElement>(".fab")!;
  const menu = root.querySelector<HTMLDivElement>(".menu")!;
  const items = root.querySelector<HTMLDivElement>(".items")!;
  const ipEl = root.querySelector<HTMLSpanElement>(".ip")!;
  const errEl = root.querySelector<HTMLDivElement>(".err")!;
  const dot = root.querySelector<HTMLSpanElement>(".dot")!;
  const search = root.querySelector<HTMLInputElement>(".search")!;
  const loading = root.querySelector<HTMLDivElement>(".loading")!;
  const loadingText = root.querySelector<HTMLSpanElement>(".loading-text")!;
  const noMatch = root.querySelector<HTMLDivElement>(".nomatch")!;
  const SEARCH_MIN = 5; // search shows only when there are more proxies than this

  let pos: FabPos = { side: "right", top: 70 };
  let busy = false;

  /**
   * Shown position: the saved one, moved aside when CitaMate's button sits at the same
   * spot (both default to the right edge) – display only, the saved position is unchanged.
   */
  const shownTop = (): string => {
    const cm = document.querySelector<HTMLElement>('[data-testid="citamate-fab"]');
    if (!cm) return `${pos.top}%`;
    const r = cm.getBoundingClientRect();
    const sameSide = pos.side === "right" ? r.left > window.innerWidth / 2 : r.right < window.innerWidth / 2;
    const ours = (pos.top / 100) * window.innerHeight;
    // CitaMate's button (50px) has its small quick-fill button under it (to ~95px): keep clear of both.
    if (!sameSide || ours <= r.top - 60 || ours >= r.top + 104) return `${pos.top}%`;
    const shift = r.top + 104 + 50 < window.innerHeight ? r.top + 104 : r.top - 64;
    return `${Math.max(4, shift)}px`;
  };
  const place = () => {
    host.style.top = shownTop();
    host.style.left = pos.side === "left" ? "14px" : "";
    host.style.right = pos.side === "right" ? "14px" : "";
    host.classList.toggle("left", pos.side === "left");
    menu.classList.toggle("left", pos.side === "left");
    fitMenu();
  };
  /** Opens towards the side with more room and caps the height to it (scrolls inside). */
  const fitMenu = () => {
    const r = fab.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - 18;
    const above = r.top - 18;
    const up = above > below;
    menu.classList.toggle("up", up);
    menu.style.maxHeight = `${Math.max(140, Math.min(320, up ? above : below))}px`;
  };
  window.addEventListener("resize", () => place());
  // CitaMate adds its button a moment after load: make way once it is there.
  setTimeout(() => place(), 1500);

  async function call(msg: PageMessage): Promise<MenuState | null> {
    try {
      const reply = (await chrome.runtime.sendMessage(msg)) as MenuReply;
      if (!reply.ok) throw new Error(reply.error);
      errEl.hidden = true;
      return reply.menu;
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      // Extension reloaded or removed: this copy is orphaned, take it down.
      if (/context invalidated/i.test(text)) {
        host.remove();
        return null;
      }
      errEl.textContent = text;
      errEl.hidden = false;
      return null;
    }
  }

  function render(m: MenuState): void {
    pos = m.pos;
    place();
    dot.className = "dot " + (m.enabled ? (m.status === "connected" ? "ok" : m.status === "connecting" ? "warn" : "bad") : "");
    ipEl.textContent = m.enabled && m.exitIp ? m.exitIp : m.enabled ? "" : "Direct";
    const active = m.items.find((i) => i.id === m.activeId);
    fab.title = m.enabled && active ? `RelaySwitch: ${active.name}` : "RelaySwitch: off";

    const rows: HTMLButtonElement[] = [];
    const row = (label: string, selected: boolean, onPick: () => void, score?: number | null) => {
      const b = document.createElement("button");
      b.className = "item" + (selected ? " sel" : "");
      b.setAttribute("role", "menuitemradio");
      b.setAttribute("aria-checked", String(selected));
      b.dataset.name = label.toLowerCase();
      const name = document.createElement("span");
      name.textContent = label;
      b.append(name);
      if (score !== undefined) {
        const badge = document.createElement("span");
        badge.className = `score ${scoreBand(score)}`;
        badge.textContent = score === null ? "–" : String(score);
        badge.title = score === null ? "Not tested yet" : `Score ${score}/100`;
        b.append(badge);
      }
      b.addEventListener("click", (e) => {
        if (!e.isTrusted || busy) return;
        b.classList.add("pending");
        onPick();
      });
      rows.push(b);
    };
    if (!m.signedIn) {
      // Signed out: no proxies to offer, only a way to sign in.
      fab.title = "RelaySwitch: sign in";
      ipEl.textContent = "";
      row("Sign in to RelaySwitch", false, () => {
        void call({ type: "menuSignIn" });
        close();
      });
      rows[0]!.dataset.testid = "fab-signin";
      search.hidden = true;
      search.value = "";
      items.replaceChildren(...rows);
      applyFilter();
      return;
    }
    row("Off (direct)", !m.enabled, () => void act({ type: "menuOff" }));
    for (const item of m.items) {
      row(item.name, m.enabled && item.id === m.activeId, () => void act({ type: "menuConnect", id: item.id }), item.score);
    }
    search.hidden = m.items.length <= SEARCH_MIN;
    if (search.hidden) search.value = "";
    if (!m.items.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No proxies yet. Add them in the web panel (Manage proxies).";
      items.replaceChildren(rows[0]!, empty);
    } else {
      items.replaceChildren(...rows);
    }
    applyFilter();
  }

  function applyFilter(): void {
    const q = search.value.trim().toLowerCase();
    let shown = 0;
    items.querySelectorAll<HTMLButtonElement>(".item").forEach((b, i) => {
      // Row 0 is "Off (direct)": always visible.
      const match = i === 0 || !q || (b.dataset.name ?? "").includes(q);
      b.hidden = !match;
      if (match && i > 0) shown++;
    });
    noMatch.hidden = !q || shown > 0;
  }

  function setLoading(text: string | null): void {
    loading.hidden = text === null;
    if (text) loadingText.textContent = text;
    fab.classList.toggle("working", text !== null);
  }

  async function act(msg: PageMessage): Promise<void> {
    busy = true;
    menu.classList.add("busy");
    setLoading(msg.type === "menuOff" ? "Turning off…" : "Connecting and checking IP…");
    const m = await call(msg);
    busy = false;
    menu.classList.remove("busy");
    setLoading(null);
    if (m) render(m);
  }

  async function open(): Promise<void> {
    menu.hidden = false;
    host.style.zIndex = "2147483647";
    fitMenu();
    fab.setAttribute("aria-expanded", "true");
    if (!items.childElementCount) setLoading("Loading…");
    const m = await call({ type: "menu" });
    setLoading(null);
    if (!m) return;
    render(m);
    if (!search.hidden) search.focus();
    else (items.querySelector(".sel") as HTMLButtonElement | null)?.focus();
  }

  function close(): void {
    menu.hidden = true;
    host.style.zIndex = "2147483646";
    fab.setAttribute("aria-expanded", "false");
  }

  // Drag to move along either edge; a short press is a click.
  let drag: { y: number; x: number; moved: boolean } | null = null;
  fab.addEventListener("pointerdown", (e) => {
    if (!e.isTrusted || e.button !== 0) return;
    drag = { y: e.clientY, x: e.clientX, moved: false };
    fab.setPointerCapture(e.pointerId);
  });
  fab.addEventListener("pointermove", (e) => {
    if (!drag) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 6) return;
    drag.moved = true;
    close();
    pos = {
      side: e.clientX < window.innerWidth / 2 ? "left" : "right",
      top: Math.min(95, Math.max(5, (e.clientY / window.innerHeight) * 100)),
    };
    place();
  });
  fab.addEventListener("pointerup", (e) => {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    if (!e.isTrusted) return;
    if (moved) void call({ type: "menuMove", pos: { side: pos.side, top: Math.round(pos.top) } });
    else if (menu.hidden) void open();
    else close();
  });
  fab.addEventListener("keydown", (e) => {
    if (e.isTrusted && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      if (menu.hidden) void open();
      else close();
    }
  });
  root.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Escape") {
      close();
      fab.focus();
    }
  });
  document.addEventListener("pointerdown", (e) => {
    if (!menu.hidden && !e.composedPath().includes(host)) close();
  }, true);
  search.addEventListener("input", applyFilter);
  search.addEventListener("keydown", (e) => {
    // Enter picks the first visible proxy.
    if (e.isTrusted && e.key === "Enter") {
      const first = [...items.querySelectorAll<HTMLButtonElement>(".item")].slice(1).find((b) => !b.hidden);
      first?.click();
    }
  });
  window.addEventListener("relayswitch:remove", () => {
    host.remove();
    window.__relayswitchFab = false;
  });

  // Initial position and status dot.
  const refresh = () =>
    void call({ type: "menu" }).then((m) => {
      if (m && !busy) render(m);
    });
  refresh();
  // Same state in every tab: follow changes made in another tab, the popup or the
  // worker (on/off, chosen proxy, sign-in), and catch up when this tab comes back.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && ["enabled", "activeProfileId", "fabPos", "refreshToken", "apiBase"].some((k) => k in changes)) refresh();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refresh();
  });
}

// The full app icon (static/brand/icon.svg), bundled as text at build time.
// Its gradient ids are prefixed so they can't clash inside other SVGs.
const ICON = ICON_SVG.replace(/id="(\w+)"/g, 'id="rs-$1"').replace(/url\(#(\w+)\)/g, "url(#rs-$1)");

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.menu, .menu * { font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; color: #1b1f24; }
.fab {
  position: relative; width: 50px; height: 50px; border-radius: 15px; border: 0; padding: 0;
  display: block; cursor: pointer; touch-action: none; background: none;
  filter: drop-shadow(0 4px 10px rgba(20, 17, 43, .35)); opacity: .9; transition: opacity .15s, transform .15s;
}
.fab svg { display: block; width: 100%; height: 100%; }
.fab:hover, .fab:focus-visible, .fab[aria-expanded="true"] { opacity: 1; transform: scale(1.06); }
.fab:focus-visible { outline: 2px solid #00C2A8; outline-offset: 3px; }
.dot { position: absolute; right: -3px; top: -3px; width: 14px; height: 14px; border-radius: 50%;
  background: #9aa5b3; border: 2px solid #fff; }
.dot.ok { background: #2e7d32; } .dot.warn { background: #f9a825; } .dot.bad { background: #c62828; }
.menu {
  position: absolute; right: 0; top: 58px; width: 240px; max-height: 320px; overflow: auto;
  background: #fff; border: 1px solid #dfe2e7; border-radius: 12px; padding: 6px;
  box-shadow: 0 10px 30px rgba(20, 17, 43, .25);
}
.menu.left { right: auto; left: 0; }
.menu.up { top: auto; bottom: 58px; }
.menu.busy .items { opacity: .55; pointer-events: none; }
.menu .search {
  display: block; width: 100%; margin: 2px 0 6px; padding: 7px 9px; border-radius: 8px;
  border: 1px solid #dfe2e7; background: #fff; outline: none;
}
.menu .search[hidden], .loading[hidden], .nomatch[hidden], .item[hidden] { display: none; }
.menu .search:focus { border-color: #3D5BFF; }
.loading { display: flex; align-items: center; gap: 8px; padding: 8px; }
.menu .loading-text, .menu .nomatch { color: #5f6b7a; font-size: 12px; }
.nomatch { padding: 8px; }
.spin, .item.pending::after {
  width: 14px; height: 14px; border-radius: 50%; flex: none;
  border: 2px solid rgba(61, 91, 255, .25); border-top-color: #3D5BFF; animation: rs-spin .8s linear infinite;
}
.item.pending::after { content: ""; margin-left: 6px; }
.menu .score { margin-left: auto; min-width: 26px; text-align: center; font-size: 11px; font-weight: 600;
  padding: 1px 5px; border-radius: 6px; background: #eef0f3; color: #5f6b7a; flex: none; }
.menu .score.good { background: #e3f4e5; color: #1f6b25; }
.menu .score.fair { background: #fff1d6; color: #8a5a00; }
.menu .score.poor { background: #fde4e4; color: #a32020; }
.fab.working .dot { background: #f9a825; animation: rs-pulse 1s ease-in-out infinite; }
@keyframes rs-spin { to { transform: rotate(360deg); } }
@keyframes rs-pulse { 50% { opacity: .35; } }
.head { display: flex; justify-content: space-between; gap: 8px; padding: 6px 8px 8px; border-bottom: 1px solid #eef0f3; margin-bottom: 4px; }
.menu .ip { color: #5f6b7a; font: 12px/1.4 ui-monospace, Menlo, monospace; }
.item {
  display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; border: 0; background: none;
  padding: 8px; border-radius: 8px; cursor: pointer; font: inherit; color: inherit;
}
.item span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.item::before { content: ""; width: 8px; height: 8px; border-radius: 50%; border: 2px solid #b8c0cc; flex: none; }
.menu .item.sel, .menu .item.sel * { font-weight: 600; }
.item.sel { background: #eef2ff; }
.item.sel::before { background: #3D5BFF; border-color: #3D5BFF; }
.item:hover, .item:focus-visible { background: #f3f5f8; outline: none; }
.menu .empty, .menu .err { padding: 8px; color: #5f6b7a; font-size: 12px; }
.menu .err { color: #c62828; }
@media (prefers-color-scheme: dark) {
  .menu, .menu * { color: #e7eaee; }
  .menu .ip, .menu .empty { color: #9aa5b3; }
  .menu { background: #1e2229; border-color: #2f3540; }
  .head { border-color: #2f3540; }
  .item.sel { background: #26304a; }
  .item:hover, .item:focus-visible { background: #2a2f38; }
  .dot { border-color: #1e2229; }
  .menu .search { background: #15181d; border-color: #2f3540; }
  .menu .score { background: #2a2f38; color: #9aa5b3; }
  .menu .score.good { background: #17361b; color: #7fd487; }
  .menu .score.fair { background: #3a2c0c; color: #ffc766; }
  .menu .score.poor { background: #3d1717; color: #ff8a8a; }
  .menu .loading-text, .menu .nomatch { color: #9aa5b3; }
}`;

// Start last: mount() uses ICON and CSS above, which must be defined first.
if (!window.__relayswitchFab && window.top === window) {
  window.__relayswitchFab = true;
  mount();
}
