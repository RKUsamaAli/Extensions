const SCRIPT_ID = "relayswitch-fab";

/** Register the on-page button only while the setting is on, so nothing is
 * injected into websites when it is off. */
export async function syncFloatingButton(enabled: boolean): Promise<void> {
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
  if (!enabled) {
    await removeFromOpenTabs();
    return;
  }
  await chrome.scripting.registerContentScripts([
    {
      id: SCRIPT_ID,
      js: ["content/fab.js"],
      matches: ["http://*/*", "https://*/*"],
      runAt: "document_idle",
      allFrames: false,
      persistAcrossSessions: true,
    },
  ]);
  await injectIntoOpenTabs();
}

async function openWebTabs(): Promise<number[]> {
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  return tabs.map((t) => t.id).filter((id): id is number => typeof id === "number");
}

async function injectIntoOpenTabs(): Promise<void> {
  for (const tabId of await openWebTabs()) {
    // Some tabs refuse injection (store pages, errors); skip them.
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content/fab.js"] }).catch(() => {});
  }
}

async function removeFromOpenTabs(): Promise<void> {
  for (const tabId of await openWebTabs()) {
    await chrome.scripting
      .executeScript({
        target: { tabId },
        func: () => window.dispatchEvent(new CustomEvent("relayswitch:remove")),
      })
      .catch(() => {});
  }
}
