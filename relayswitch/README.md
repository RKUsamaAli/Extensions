# RelaySwitch

Switch between proxies from any provider. Since 0.2.0 RelaySwitch needs an account on an
**ext-hub** server (`../ext-hub`): proxies, test results and activity are stored there, and the
extension does nothing until you sign in. There is no offline mode.

## How it works with the server

- Sign in from the popup or the options page (username, password, server address; the default
  address is `DEFAULT_API_BASE` in `src/shared/config.ts`).
- Proxies are added, edited and deleted in the **web panel** (Manage proxies ↗ in the popup and
  options page). The server refuses those changes from the extension; it only reads proxies and
  sends check results and activity.
- The worker keeps a refresh token in `storage.local` and a short-lived access token in
  `storage.session`. Proxies (with passwords), scores and logs are cached only in
  `storage.session`, which is cleared when the browser closes and can't be read by content scripts.
- Activity and check results are sent to the server in batches every few seconds.
- If the server ends the sign-in (expired access, disabled account, removed device, …) the proxy is
  turned off, the cache is cleared and the reason is shown on the sign-in form.
- Traffic to the server itself always bypasses the proxy.
- Proxies saved by 0.1.x in this browser: the options page copies them as a list for Bulk add
  in the web panel, then removes them from the browser.

API contract: `../ext-hub/docs/API.md`.

## Develop

```sh
npm install
npm run build      # or: npm run watch
npm test
npm run typecheck
```

Load in Chrome: `chrome://extensions` → Developer mode → Load unpacked → pick `dist/`.
Start the ext-hub server (default `http://localhost:4000`) before signing in.

## Layout

- `src/core/` pure logic (parser, username templates, server data helpers), unit-tested
- `src/shared/hub.ts` ext-hub API client (tokens, refresh-and-retry, error messages), unit-tested
- `src/background/` service worker; the only place that calls chrome.proxy / webRequest and the server
  (`sync.ts`: sign-in, loading, saving, batched uploads, migration)
- `src/popup/`, `src/options/` UI; they only send messages to the worker
- `static/` manifest and icons, copied into `dist/`

## Features

- Proxies from any provider: HTTP, HTTPS, SOCKS4, SOCKS5, kept in your account
- Add one at a time or in bulk (one per line, named by server by default)
- Username templates with {session}, {country}, {city}; "New session" button
- Proxy login handled by the extension; stops after repeated login failures
- Exit-IP check with response time
- Score out of 100 per proxy (reliability + speed), Test / Test all
- Activity log, filterable per proxy
- Optional floating button on pages to switch proxy quickly

Next: per-site rules (PAC), automatic failover, Firefox build.
