import type { ProxyProfile, RuntimeState } from "../core/types";

/** What the on-page button may see: names and status only, never credentials. */
export interface MenuState {
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

export interface Settings {
  floatingButton: boolean;
}

/** Messages any extension page may send. */
export type Message =
  | { type: "getState" }
  | { type: "setEnabled"; enabled: boolean }
  | { type: "checkIp" }
  | { type: "newSession" }
  | { type: "saveProfile"; profile: ProxyProfile }
  | { type: "deleteProfile"; id: string }
  | { type: "setActive"; id: string }
  | { type: "listProfiles" }
  | { type: "clearLogs" }
  | { type: "setSettings"; settings: Partial<Settings> }
  | { type: "bulkAdd"; profiles: ProxyProfile[] }
  | { type: "testProxies"; ids?: string[] }
  | { type: "cancelTests" };

/** The only messages accepted from the on-page button (a content script). */
export type PageMessage =
  | { type: "menu" }
  | { type: "menuConnect"; id: string }
  | { type: "menuOff" }
  | { type: "menuMove"; pos: FabPos };

export type Reply =
  | {
      ok: true;
      state: RuntimeState;
      profiles: ProxyProfile[];
      settings: Settings;
      /** Score out of 100 per proxy id; null = not checked yet. */
      scores: Record<string, number | null>;
      /** Set when bulkAdd ran. */
      added?: number;
    }
  | { ok: false; error: string };

export type MenuReply = { ok: true; menu: MenuState } | { ok: false; error: string };

export async function send(msg: Message): Promise<Reply> {
  return (await chrome.runtime.sendMessage(msg)) as Reply;
}
