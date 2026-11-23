// Build-time settings. API_BASE is the default server address shown on the sign-in form;
// users can change it there (saved as cm.apiBase in chrome.storage.local).
globalThis.CM_CONFIG = Object.freeze({
  API_BASE: "http://localhost:4000",
  EXT: "citamate",
});
