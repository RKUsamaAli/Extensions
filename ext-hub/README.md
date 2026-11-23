# ext-hub

The backend for the **CitaMate** and **RelaySwitch** browser extensions. Both extensions are
useless without it: they keep no data on disk and work only while signed in to this server.

- **Users and roles**: admins see and manage everyone's data, users only their own.
- **Access per extension**: an expiry date (or never) and a maximum number of devices.
- **Devices**: every install registers itself; removing one signs it out at once.
- **CitaMate**: autofill entries (personal data encrypted at rest), activity log, office
  sightings, the province/trámite/office catalog and the page selectors (site config).
- **RelaySwitch**: proxies (passwords encrypted at rest), check history (scores), logs.
- **Web panel** at `/app`: everything above, plus admin pages (users, access, settings,
  catalog and config editor, audit log).
- **Kill switches**: minimum extension version and on/off per extension.

API contract: [docs/API.md](docs/API.md).

## Run locally

```sh
npm install
npm run migrate                                   # creates data/ext-hub.db, loads seeds/
npm run cli -- create-admin admin                 # prints a generated password
npm run cli -- create-admin ali 'password-123'
npm run cli -- grant ali citamate 2026-12-31 2    # access until that date, 2 devices
npm run cli -- grant ali relayswitch never 1
npm run dev                                       # http://localhost:4000/app
```

Load the extensions unpacked; their sign-in form has a **Server address** field that
defaults to `http://localhost:4000`.

## Tests

```sh
npm test        # node:test — services, auth, HTTP API (real Express on a random port), CLI
```

## Layout

| Path | What |
|---|---|
| `src/server.js` | entry point (listen, hourly maintenance, graceful shutdown) |
| `src/web/app.js` | Express app factory: security headers, extension CORS, routes, panel pages |
| `src/web/routes/` | `auth`, `data` (bootstrap, citamate, relayswitch, devices, dashboard), `admin` |
| `src/services/` | business logic; each service gets the db and an injectable clock |
| `src/services/auth.js` | login, refresh, device limit, expiry, version and kill-switch checks |
| `src/services/ownership.js` | who may see / change which rows |
| `src/lib/` | JWT, scrypt, AES-GCM, rate limiter, ids (UUID v7), errors |
| `src/db/migrations/` | SQL schema (add new numbered files; keep them additive) |
| `seeds/` | CitaMate catalog and site config loaded on first start |
| `public/` | web panel (vanilla JS modules, strict CSP) |
| `src/cli.js` | admin command line |

## How sign-in works

| Token | Where | Lifetime |
|---|---|---|
| Access (JWT) | extension `storage.session` / panel memory | 10 min |
| Refresh (random, only its hash in the db) | extension `storage.local` / panel HttpOnly cookie `eh_rt` | 30 days ext / 7 days panel, sliding |

Every request re-reads the user, the sign-in session and (for extensions) the device, so
disabling a user, removing a device, signing out everywhere or an access expiry takes effect
on the very next call. Extension calls also check the extension is switched on and the
`X-Client` version is not below the minimum.

## Deploy (Ubuntu, same pattern as the old portal)

1. Node 20+, nginx, PM2 (`npm i -g pm2`), certbot.
2. Copy the folder, `npm ci --omit=dev`, `cp .env.example .env`, fill `APP_SECRET`
   (`openssl rand -hex 32`), `PUBLIC_URL`, and `ALLOWED_EXTENSION_IDS` with the store ids.
3. `npm run migrate && npm run cli -- create-admin <you>`
4. `pm2 start ecosystem.config.js && pm2 save && pm2 startup`
5. nginx: `deploy/nginx.conf.example`, then `certbot --nginx -d api.example.com`.
6. Back up `data/ext-hub.db` (e.g. `sqlite3 data/ext-hub.db ".backup backup.db"` nightly)
   and keep `APP_SECRET` / `DATA_KEY` safe: encrypted data cannot be read without them.
7. Set the extensions' default server address (`icp-autofill/config.js`,
   `relayswitch/src/shared/config.ts`) to `PUBLIC_URL` before publishing them.
