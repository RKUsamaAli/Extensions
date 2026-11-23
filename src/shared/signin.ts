// Sign-in form and account line shared by the popup and the options page.
import { send, type AuthInfo, type Reply } from "./messages";

type OkReply = Extract<Reply, { ok: true }>;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}

/** "Access until 31 Dec 2026", "Access never expires", or "" when unknown. */
export function accessText(auth: AuthInfo): string {
  const e = auth.entitlement;
  if (auth.user?.role === "admin" && !e) return "Admin";
  if (!e) return "";
  if (e.expiresAt === null) return "Access never expires";
  const day = new Date(e.expiresAt).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
  return e.active ? `Access until ${day}` : `Access expired on ${day}`;
}

/**
 * Renders the sign-in form into `box`. `onSignedIn` gets the worker's reply
 * after a successful sign-in.
 */
export function renderSignIn(box: HTMLElement, auth: AuthInfo, onSignedIn: (reply: OkReply) => void): void {
  const form = el("form", { class: "signin", "data-testid": "login-form", autocomplete: "on" });
  const title = el("h2", {}, "Sign in to RelaySwitch");
  const intro = el("p", { class: "muted" }, "RelaySwitch works with your account: your proxies are kept on the server.");

  const field = (id: string, label: string, input: HTMLInputElement) => {
    const wrap = el("div", { class: "field" });
    wrap.append(el("label", { for: id }, label), input);
    return wrap;
  };
  const user = el("input", { id: "signinUser", name: "username", autocomplete: "username", required: "", "data-testid": "login-username" });
  const pass = el("input", { id: "signinPass", name: "password", type: "password", autocomplete: "current-password", required: "", "data-testid": "login-password" });
  const server = el("input", { id: "signinServer", name: "server", class: "mono", spellcheck: "false", "data-testid": "login-server" });
  server.value = auth.apiBase;

  const more = el("details", { class: "server" });
  more.append(el("summary", { class: "muted" }, "Server"), field("signinServer", "Server address", server));

  const error = el("p", { class: "error", role: "alert", "data-testid": "login-error" });
  error.hidden = !auth.error;
  error.textContent = auth.error ?? "";
  // Show the server field straight away when the problem may be the address.
  if (auth.error && /reach server/i.test(auth.error)) more.open = true;

  const submit = el("button", { type: "submit", class: "primary", "data-testid": "login-submit" });
  const spin = el("span", { class: "spinner" });
  spin.hidden = true;
  const label = el("span", {}, "Sign in");
  submit.append(spin, label);

  form.append(title, intro, field("signinUser", "Username", user), field("signinPass", "Password", pass), more, error, submit);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void (async () => {
      submit.disabled = true;
      spin.hidden = false;
      label.textContent = "Signing in…";
      error.hidden = true;
      const reply = await send({ type: "login", username: user.value, password: pass.value, apiBase: server.value });
      submit.disabled = false;
      spin.hidden = true;
      label.textContent = "Sign in";
      if (!reply.ok) {
        error.textContent = reply.error;
        error.hidden = false;
        if (/reach server|server address/i.test(reply.error)) more.open = true;
        return;
      }
      pass.value = "";
      onSignedIn(reply);
    })();
  });

  box.replaceChildren(form);
  (user.value ? pass : user).focus();
}

/** "ali · Access until …  [Sign out]". */
export function renderAccount(box: HTMLElement, auth: AuthInfo, onSignedOut: (reply: OkReply) => void): void {
  const name = el("strong", { "data-testid": "account-user" }, auth.user?.username ?? "Signed in");
  const access = el("span", { class: "muted", "data-testid": "account-expiry" }, accessText(auth));
  const out = el("button", { type: "button", "data-testid": "signout" }, "Sign out");
  out.addEventListener("click", () => {
    out.disabled = true;
    void send({ type: "logout" }).then((reply) => {
      out.disabled = false;
      if (reply.ok) onSignedOut(reply);
    });
  });
  const text = el("span", { class: "grow account-text" });
  text.append(name);
  if (access.textContent) text.append(document.createTextNode(" · "), access);
  box.replaceChildren(text, out);
}
