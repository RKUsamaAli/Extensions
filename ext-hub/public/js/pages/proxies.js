// RelaySwitch proxies.
import { get, post, put, del, qs } from "../api.js";
import { el, table, drawer, confirmDialog, toast, toastError, field, input, select, formValues, fmtTime, badge } from "../ui.js";
import { ownerParam, ownerSelect, pageHead, showOwner } from "../state.js";
import { parseProxyList } from "../proxyParse.js";

const SCHEMES = [
  { value: "http", text: "HTTP" },
  { value: "https", text: "HTTPS" },
  { value: "socks4", text: "SOCKS4" },
  { value: "socks5", text: "SOCKS5" },
];

function passwordField(value) {
  const inp = input("password", value, { type: "password", autocomplete: "new-password", testid: "proxy-password" });
  const btn = el("button", { type: "button", class: "btn small", "aria-label": "Show password", testid: "proxy-password-toggle" }, "Show");
  btn.addEventListener("click", () => {
    const show = inp.type === "password";
    inp.type = show ? "text" : "password";
    btn.textContent = show ? "Hide" : "Show";
    btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
  });
  return el("div", { class: "row" }, inp, btn);
}

function openEditor(p, onDone) {
  const x = p || { scheme: "http", sessionStart: 1, sessionEnd: 1000 };
  const body = el(
    "div",
    { class: "form-grid" },
    field("Name", input("name", x.name, { placeholder: "Defaults to host:port", testid: "proxy-name" }), { wide: true }),
    field("Type", select("scheme", SCHEMES, x.scheme || "http", { testid: "proxy-scheme" })),
    field("Host *", input("host", x.host, { required: true, autocapitalize: "none", spellcheck: "false", testid: "proxy-host" })),
    field("Port *", input("port", x.port, { type: "number", min: 1, max: 65535, required: true, testid: "proxy-port" })),
    field("Username", input("usernameTemplate", x.usernameTemplate, { autocapitalize: "none", spellcheck: "false", testid: "proxy-username" }), {
      wide: true,
      hint: "Plain username or a template with {session}, {country}, {city}.",
    }),
    el("label", { class: "wide" }, "Password", passwordField(x.password)),
    field("Country", input("country", x.country, { placeholder: "e.g. de", testid: "proxy-country" })),
    field("City", input("city", x.city, { testid: "proxy-city" })),
    field("Session from", input("sessionStart", x.sessionStart ?? 1, { type: "number", min: 0, testid: "proxy-sessionStart" })),
    field("Session to", input("sessionEnd", x.sessionEnd ?? 1000, { type: "number", min: 0, testid: "proxy-sessionEnd" })),
  );
  drawer({
    title: p ? "Edit proxy" : "Add proxy",
    body,
    testid: "proxy-drawer",
    async onSave(form) {
      const v = formValues(form);
      const data = {
        name: v.name.trim() || `${v.host.trim()}:${v.port}`,
        scheme: v.scheme,
        host: v.host.trim(),
        port: Number(v.port),
        usernameTemplate: v.usernameTemplate.trim(),
        password: v.password,
        country: v.country.trim(),
        city: v.city.trim(),
        sessionStart: Number(v.sessionStart) || 0,
        sessionEnd: Number(v.sessionEnd) || 0,
      };
      if (!data.host || !(data.port >= 1 && data.port <= 65535)) {
        const err = new Error("Host and a port between 1 and 65535 are required.");
        err.body = { fields: { ...(data.host ? {} : { host: "Required" }), ...(data.port >= 1 && data.port <= 65535 ? {} : { port: "1–65535" }) } };
        throw err;
      }
      if (p) await put("/relayswitch/proxies/" + encodeURIComponent(p.id), data);
      else await post("/relayswitch/proxies", data);
      toast(p ? "Proxy saved." : "Proxy added.", "ok");
      onDone();
    },
  });
}

function openBulk(onDone) {
  const area = el("textarea", { name: "list", rows: 12, class: "code", spellcheck: "false", testid: "proxy-bulk-text", placeholder: "1.2.3.4:8080:user:pass\nsocks5://user:pass@host:1080" });
  area.style.minHeight = "14rem";
  const preview = el("div", { class: "hint", testid: "proxy-bulk-preview" });
  const scheme = select("scheme", SCHEMES, "http", { testid: "proxy-bulk-scheme" });
  const update = () => {
    const { items, errors } = parseProxyList(area.value, scheme.value);
    preview.textContent = `${items.length} proxies ready` + (errors.length ? `, ${errors.length} lines can't be read: ` + errors.slice(0, 5).map((e) => `line ${e.line} (${e.message})`).join("; ") : "");
  };
  area.addEventListener("input", update);
  scheme.addEventListener("change", update);
  drawer({
    title: "Bulk add proxies",
    saveLabel: "Add all",
    testid: "proxy-bulk-drawer",
    body: el(
      "div",
      { class: "stack" },
      el("p", { class: "hint" }, "One proxy per line: host:port, host:port:user:pass, user:pass@host:port or scheme://user:pass@host:port. Lines starting with # are skipped."),
      field("Type for lines without a scheme", scheme),
      field("Proxies", area),
      preview,
    ),
    async onSave() {
      const { items, errors } = parseProxyList(area.value, scheme.value);
      if (!items.length) throw new Error(errors.length ? `No line could be read (line ${errors[0].line}: ${errors[0].message}).` : "Paste at least one proxy.");
      if (items.length > 1000) throw new Error("At most 1000 proxies at once.");
      const r = await post("/relayswitch/proxies/bulk", { items });
      toast(`Added ${(r.items || []).length} proxies.` + (errors.length ? ` ${errors.length} lines skipped.` : ""), "ok");
      onDone();
    },
  });
}

export default async function proxiesPage() {
  const root = el("div");
  let items = [];
  let stats = {};
  const search = el("input", { type: "search", placeholder: "Search name, host, country…", "aria-label": "Search proxies", testid: "proxies-search" });
  const listBox = el("div");

  function lastCheck(id) {
    const r = stats[id] && stats[id].results;
    return r && r.length ? r[r.length - 1] : null;
  }

  function renderList() {
    const term = search.value.trim().toLowerCase();
    const rows = items.filter((r) => !term || [r.name, r.host, r.country, r.city, r.ownerName].some((v) => String(v || "").toLowerCase().includes(term)));
    const cols = [
      { label: "Name", render: (r) => el("strong", null, r.name) },
      { label: "Type", render: (r) => String(r.scheme || "").toUpperCase() },
      { label: "Server", render: (r) => el("span", { class: "mono" }, `${r.host}:${r.port}`) },
      { label: "Username", render: (r) => (r.usernameTemplate ? el("span", { class: "mono" }, r.usernameTemplate) : "") },
      { label: "Location", render: (r) => [r.country, r.city].filter(Boolean).join(" / ").toUpperCase() },
      {
        label: "Last check",
        render: (r) => {
          const c = lastCheck(r.id);
          if (!c) return badge("Not checked");
          return c.ok ? badge(`OK${c.ms ? " " + c.ms + " ms" : ""}`, "ok") : badge(c.error ? "Failed: " + c.error : "Failed", "bad");
        },
      },
    ];
    if (showOwner()) cols.push({ label: "Owner", render: (r) => r.ownerName });
    cols.push({ label: "Updated", render: (r) => fmtTime(r.updatedAt) });
    cols.push({
      label: "",
      class: "actions",
      render: (r) =>
        el(
          "span",
          null,
          el("button", { type: "button", class: "btn small", testid: "row-edit", onclick: () => openEditor(r, load) }, "Edit"),
          el("button", {
            type: "button",
            class: "btn small danger",
            testid: "row-delete",
            onclick: async () => {
              if (!(await confirmDialog(`Delete the proxy "${r.name}"?`))) return;
              try {
                await del("/relayswitch/proxies/" + encodeURIComponent(r.id));
                toast("Proxy deleted.", "ok");
                load();
              } catch (e) { toastError(e); }
            },
          }, "Delete"),
        ),
    });
    listBox.textContent = "";
    listBox.append(
      table(cols, rows, { testid: "proxies-table", empty: items.length ? "No proxy matches the search." : "No proxies yet. Add one or paste a list." }),
      el("p", { class: "hint" }, `${rows.length} of ${items.length} proxies`),
    );
  }

  async function load() {
    const q = qs({ owner: ownerParam() });
    try {
      const [p, c] = await Promise.all([get("/relayswitch/proxies" + q), get("/relayswitch/checks" + q).catch(() => ({ stats: {} }))]);
      items = p.items || [];
      stats = c.stats || {};
    } catch (e) {
      items = [];
      toastError(e);
    }
    renderList();
  }

  search.addEventListener("input", renderList);
  root.append(
    pageHead(
      "RelaySwitch proxies",
      ownerSelect(load),
      el("button", { type: "button", class: "btn", testid: "proxy-bulk", onclick: () => openBulk(load) }, "Bulk add"),
      el("button", { type: "button", class: "btn primary", testid: "proxy-add", onclick: () => openEditor(null, load) }, "Add proxy"),
    ),
    el("div", { class: "toolbar" }, search),
    listBox,
  );
  await load();
  return root;
}
