# RelaySwitch

Switch between your own proxies, from any provider. Free, no account, no backend.

## Develop

```sh
npm install
npm run build      # or: npm run watch
npm test
npm run typecheck
```

Load in Chrome: `chrome://extensions` → Developer mode → Load unpacked → pick `dist/`.

## Layout

- `src/core/` pure logic (parser, username templates), unit-tested
- `src/background/` service worker; the only place that calls chrome.proxy / webRequest
- `src/popup/`, `src/options/` UI; they only send messages to the worker
- `static/` manifest and icons, copied into `dist/`

## Features

- Proxies from any provider: HTTP, HTTPS, SOCKS4, SOCKS5
- Add one at a time or in bulk (one per line, named by server by default)
- Username templates with {session}, {country}, {city}; "New session" button
- Proxy login handled by the extension; stops after repeated login failures
- Exit-IP check with response time
- Score out of 100 per proxy (reliability + speed), Test / Test all
- Activity log, filterable per proxy
- Optional floating button on pages to switch proxy quickly

Next: per-site rules (PAC), automatic failover, import/export, Firefox build.
