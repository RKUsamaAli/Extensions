import { login, refresh } from "./api.js";
import { setBusy } from "./ui.js";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

function safeNext() {
  const n = params.get("next") || "";
  // only same-site paths, never "//host" or absolute URLs
  return /^\/(?!\/)[\w\-./#?=&%]*$/.test(n) && !n.startsWith("/login") ? n : "/app";
}

if (params.get("expired")) {
  $("notice").textContent = "Your session ended. Please sign in again.";
  $("notice").hidden = false;
} else if (params.get("signedout")) {
  $("notice").textContent = "You are signed out.";
  $("notice").hidden = false;
}

// Already signed in (refresh cookie still valid)? Go straight in.
if (!params.get("signedout")) {
  refresh().then(() => location.replace(safeNext())).catch(() => {});
}

$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("error");
  err.hidden = true;
  const username = $("username").value.trim();
  const password = $("password").value;
  if (!username || !password) {
    err.textContent = "Enter your username and password.";
    err.hidden = false;
    return;
  }
  setBusy($("submit"), true, "Signing in…");
  try {
    await login(username, password);
    location.replace(safeNext());
  } catch (ex) {
    const msgs = {
      invalid_credentials: "Wrong username or password.",
      account_pending: "Your account is waiting for admin approval.",
      account_disabled: "Your account is disabled. Contact the admin.",
    };
    err.textContent = msgs[ex.code] || ex.message;
    if (ex.code === "too_many_requests" && ex.body.retryAfter) err.textContent += ` Try again in ${ex.body.retryAfter} s.`;
    err.hidden = false;
    $("password").select();
  } finally {
    setBusy($("submit"), false);
  }
});
