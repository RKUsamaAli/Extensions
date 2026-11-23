import type { ProxyProfile, RuntimeState } from "../core/types";
import type { HubEntitlement, HubUser } from "./hub";

/** Sign-in state shown by the popup, options page and on-page button. */
export interface AuthInfo {
  signedIn: boolean;
  /** Server address (prefills the sign-in form). */
  apiBase: string;
  user?: HubUser;
  entitlement?: HubEntitlement | null;
  /** Why the user is signed out, or a server problem while signed in. */
  error?: string;
}

/** Counts of data saved by older versions in this browser, waiting to be uploaded. */
export interface LegacyInfo {
  profiles: number;
  logs: number;
  checks: number;
}

/** What the on-page button may see: names and status only, never credentials. */
export interface MenuState {
  /** False = the menu only offers "Sign in to RelaySwitch". */
  signedIn: boolean;
  enabled: boolean;
  activeId: string | null;
  status: RuntimeState["status"];
  exitIp: string | null;
  items: { id: string; name: string; score: number | null }[];
  pos: FabPos;
}

export interface FabPos {
  side: "left" | "right";
  /** Distance from the top of the window, in %. */
  top: number;
}

export interface SupportInfo {
  canProxy: boolean;
  missing: string[];
  limited: string[];
  /** proxy.settings exists but never answers (e.g. Orion on iOS). */
  unresponsive: boolean;
}

export interface Settings {
  floatingButton: boolean;
}

/** Messages any extension page may send. */
export type Message =
  | { type: "getState" }
  | { type: "setEnabled"; enabled: boolean }
  | { type: "checkIp" }
  | { type: "newSession" }
  | { type: "setActive"; id: string }
  | { type: "listProfiles" }
  | { type: "clearLogs" }
  | { type: "setSettings"; settings: Partial<Settings> }
  | { type: "testProxies"; ids?: string[] }
  | { type: "cancelTests" }
  | { type: "browserCheck" }
  | { type: "getAuth" }
  | { type: "login"; username: string; password: string; apiBase: string }
  | { type: "logout" }
  | { type: "legacyExport" }
  | { type: "dropLegacy" };

/** The only messages accepted from the on-page button (a content script). */
export type PageMessage =
  | { type: "menu" }
  | { type: "menuConnect"; id: string }
  | { type: "menuOff" }
  | { type: "menuMove"; pos: FabPos }
  | { type: "menuSignIn" };

export type Reply =
  | {
      ok: true;
      state: RuntimeState;
      profiles: ProxyProfile[];
      settings: Settings;
      /** Score out of 100 per proxy id; null = not checked yet. */
      scores: Record<string, number | null>;
      /** Sign-in state; when signedIn is false, profiles is empty. */
      auth: AuthInfo;
      /** Data saved by RelaySwitch 0.1.x in this browser (to move to the web panel); null = none. */
      legacy: LegacyInfo | null;
      /** Set when legacyExport ran: the old proxies, one per line, for Bulk add in the web panel. */
      legacyText?: string;
      /** What this browser supports; canProxy false = RelaySwitch can't work here. */
      support: SupportInfo;
      /** Set when browserCheck ran. */
      check?: { name: string; ok: boolean; ms: number; detail: string }[];
    }
  | { ok: false; error: string };

export type MenuReply = { ok: true; menu: MenuState } | { ok: false; error: string };

/** Long actions (connect + IP check, bulk add) finish well within this. */
const REPLY_TIMEOUT_MS = 30_000;

export async function send(msg: Message): Promise<Reply> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Reply>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          ok: false,
          error:
            "RelaySwitch's background didn't answer. Reload the extension. If it keeps happening, this browser may not support RelaySwitch.",
        }),
      msg.type === "getAuth" ? 8_000 : REPLY_TIMEOUT_MS,
    );
  });
  try {
    const reply = Promise.resolve(chrome.runtime.sendMessage(msg) as Promise<Reply | undefined>).then(
      (r): Reply => r ?? { ok: false, error: "No answer from RelaySwitch. Reload the extension." },
    );
    return await Promise.race([reply, timeout]);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}
