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

## Deploy (Ubuntu 22.04 / 24.04)

Scripts in [`deploy/`](deploy/), same pattern as the web-proxy-portal kit: every deploy is a
new folder under `/opt/ext-hub/releases/`, `current` is switched atomically, tests run before
anything goes live, the database is backed up first, and if `/healthz` doesn't report the new
release the previous one is put back automatically.

First time, on the server:

```sh
sudo apt-get update && sudo apt-get install -y git
git clone https://github.com/RKUsamaAli/Extensions.git ~/Extensions
sudo ~/Extensions/ext-hub/deploy/setup-server.sh            # no domain: http://<server ip>
# or, with a domain pointing at the server:
# sudo ~/Extensions/ext-hub/deploy/setup-server.sh --domain api.example.com --email you@example.com
sudo exthub-deploy
sudo exthub-cli create-admin admin                          # prints the password
```

Then open `<address>/app`. The extensions, with this server set as their default address,
are at `<address>/downloads/` (rebuilt on every deploy).

| Command | What |
|---|---|
| `sudo exthub-deploy [--ref <branch/tag/sha>]` | deploy (default: latest `main`) |
| `sudo exthub-rollback [--list \| --to <release>] [--restore-db]` | back to an earlier release |
| `sudo exthub-status` | release, health, process, zips, certificate, disk |
| `sudo exthub-logs [errors\|nginx\|deploys]` | follow logs |
| `sudo exthub-cli <command>` | admin CLI (`create-admin`, `grant`, `users`, ...) |
| `sudo exthub-backup` | DB + `.env` archive (also daily at 03:23) |
| `sudo exthub-restart` | after editing `/opt/ext-hub/shared/.env` |
| `sudo exthub-setup [--domain D --email E \| --ssl-only \| --nginx-only]` | re-run setup / add HTTPS later |

Settings: `/etc/ext-hub/deploy.env` (deploy) and `/opt/ext-hub/shared/.env` (app). Keep
`APP_SECRET` / `DATA_KEY` safe and copy `shared/backups/` off the server: encrypted data
cannot be read without them. On AWS, open TCP 80 and 443 in the instance's Security Group.
Set `ALLOWED_EXTENSION_IDS` in the app `.env` once the extensions have store ids.
