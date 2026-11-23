# ext-hub API contract (v1)

Base URL: `https://api.<your-domain>` in production, `http://localhost:4000` in development.
All paths start with `/api/v1`. Bodies are JSON (`Content-Type: application/json`).
All times are **epoch milliseconds (UTC)**. All ids are server-generated UUID v7 strings
unless stated.

## Clients and headers

| Header | Who sends it | Meaning |
|---|---|---|
| `Authorization: Bearer <accessToken>` | every signed-in call | access token (JWT, 10 min) |
| `X-Client: <ext>/<version>` | extensions | e.g. `citamate/1.6.0`, `relayswitch/0.2.0`. The server answers `426 update_required` when the version is below the admin-set minimum |
| `X-Device-Id: <id>` | extensions | random id created once per install (`crypto.randomUUID()`), kept in `chrome.storage.local` |

`ext` values: `citamate`, `relayswitch`.

CORS: the server answers `chrome-extension://<id>` / `moz-extension://<id>` origins
(restricted to `ALLOWED_EXTENSION_IDS` in production). No cookies are used by extensions.

## Errors

Every error is `{"code": "<code>", "message": "<human text>", ...extra}` with:

| Status | code | extra | Client should |
|---|---|---|---|
| 400 | `validation_error` | `fields: {name: message}` | show messages |
| 401 | `not_signed_in` | | show login |
| 401 | `invalid_credentials` | | show "wrong username or password" |
| 401 | `access_token_expired` | | call `/auth/refresh` once, retry the call once |
| 401 | `session_expired` | | refresh token invalid/expired/revoked → show login |
| 403 | `account_disabled` / `account_pending` | | show message, sign out |
| 403 | `no_entitlement` | `ext` | "Your account has no access to <ext>" |
| 403 | `subscription_expired` | `ext`, `expiresAt` | "Access expired on <date>" , sign out |
| 403 | `device_limit` | `maxDevices` | "Device limit reached – ask admin to remove a device" |
| 403 | `device_revoked` | | sign out |
| 403 | `forbidden` | | |
| 404 | `not_found` | | |
| 409 | `conflict` | | e.g. username taken |
| 426 | `update_required` | `minVersion` | "Please update the extension" |
| 429 | `too_many_requests` | `retryAfter` (s) | wait |
| 503 | `ext_disabled` | `ext` | admin switched this extension off |

Network failure = server unreachable: extensions show "Can't reach server" and do nothing
(no offline mode).

## Auth

### `POST /auth/login`
```json
{ "username": "ali", "password": "…",
  "client": { "kind": "extension", "ext": "citamate", "deviceId": "…", "deviceName": "Chrome on macOS", "version": "1.6.0" } }
```
`client.kind` is `"extension"` or `"panel"` (panel needs no other client fields).

200:
```json
{ "accessToken": "…", "accessExpiresAt": 1764000000000,
  "refreshToken": "…",            // extensions only; the panel gets an HttpOnly cookie instead
  "refreshExpiresAt": 1766000000000,
  "user": { "id": "…", "username": "ali", "email": null, "role": "user" },
  "entitlements": [ { "ext": "citamate", "expiresAt": 1767139200000, "maxDevices": 2, "active": true } ] }
```
Extension logins are checked for: entitlement for `ext` (admins always pass), expiry,
device limit (a known `deviceId` never counts twice), extension enabled, min version.

### `POST /auth/refresh`
Body `{ "refreshToken": "…" }` (extensions, with `X-Device-Id`, which must match the device
the sign-in belongs to) or the `eh_rt` cookie (panel, same-origin only).
200 → `{ accessToken, accessExpiresAt, refreshExpiresAt }` (the refresh token itself is not
rotated; its expiry slides). Same checks as login.

### `POST /auth/logout`  (Bearer) → `{ "ok": true }` — revokes this sign-in session.
### `GET /auth/me` (Bearer) → `{ user, entitlements }`
### `POST /auth/password` (Bearer) `{ "current": "…", "next": "…" }` → `{ ok: true }` — signs out all other sessions.
### `POST /auth/register` `{ username, password, email? }` → `{ ok: true, pending: true }` (only when the admin enabled sign-ups; new users wait for approval). 403 `forbidden` when disabled.

Password rules: 8–200 chars. Username: 3–40 chars, `[A-Za-z0-9._-]`.

## Bootstrap (extensions)

### `GET /bootstrap?ext=citamate`
```json
{ "user": {…}, "entitlement": { "ext": "citamate", "expiresAt": 1767139200000, "maxDevices": 2, "active": true },
  "minVersion": "1.6.0", "enabled": true,
  "catalogVersion": 3,          // citamate only, null for relayswitch
  "siteConfig": { … },          // per-extension JSON the admin can edit (see below), {} when none
  "serverTime": 1764000000000 }
```

## Ownership rules (all data endpoints)

Every row has `ownerId` and `ownerName`. A **user** sees and changes only their own rows.
An **admin** sees everyone's rows: list endpoints accept `?owner=<userId>` (one user) or
`?owner=all`; without `owner` an admin gets **only their own** rows (so the extension behaves
the same for admins). Admins may update/delete any row. Creating always creates for the
caller, except an admin may pass `"ownerId"` in the body to create for another user.

Data endpoints under `/citamate/*` and `/relayswitch/*` require an active entitlement for
that extension when called **with an extension token**; panel tokens may always manage data.

## CitaMate

### Entry (profile) object — same field names as the extension uses today
```json
{ "id": "…", "label": "Ali – TIE renewal", "docType": "NIE", "docNumber": "X1234567L",
  "fullName": "ALI KHAN", "birthYear": "1990",
  "nationality": "…", "nationalityText": "PAKISTAN",
  "province": "/icpplus/citar?p=8&locale=es", "provinceText": "Barcelona",
  "tramite": "4010", "tramiteText": "POLICIA-TOMA DE HUELLAS…",
  "office": "16", "officeText": "CNP …",
  "phone": "600000000", "email": "a@b.c", "notes": "",
  "ownerId": "…", "ownerName": "ali", "createdAt": 0, "updatedAt": 0 }
```
Server-side validation/normalization: `label`, `docNumber`, `fullName` required;
`docType` ∈ NIE|DNI|PASAPORTE (default NIE); `docNumber` upper-cased without spaces;
`fullName` upper-cased; `birthYear` digits only, max 4. All string fields ≤ 500 chars.

| Method & path | Body | 200 |
|---|---|---|
| `GET /citamate/profiles?owner=` | | `{ items: [entry] }` (sorted by label) |
| `POST /citamate/profiles` | entry fields | `{ item }` (201) |
| `POST /citamate/profiles/bulk` | `{ items: [entry fields] }` (≤ 1000) | `{ items }` (201) — import / migration. All-or-nothing; `items` come back **in input order** (the migration maps old → new ids by position) |
| `PUT /citamate/profiles/:id` | entry fields | `{ item }` |
| `DELETE /citamate/profiles/:id` | | `{ ok: true }` |

### Logs (activity log)
Log object (what `content.js` writes today):
`{ id, t, page, url, kind: "booking"|"check", entry, entryId, action, status, detail }`.
`id` here is the **client's** id (kept for de-duplication, unique per owner); the server adds
`ownerId`, `ownerName`.

| Method & path | Body | 200 |
|---|---|---|
| `GET /citamate/logs?owner=&entryId=&limit=` | | `{ items }` oldest → newest, last `limit` (default 1000, max 5000) |
| `POST /citamate/logs` | `{ items: [log] }` (≤ 500) | `{ saved: n }` (duplicates by id ignored) |
| `DELETE /citamate/logs` | | `{ removed: n }` (own rows only, admin too) |

### Office sightings
`{ id, t, entry, entryId, province, tramite, kind, offices: [{ value, text }] }`
(`id` is the client's id, generate one if the extension doesn't have one.)

| Method & path | Body | 200 |
|---|---|---|
| `GET /citamate/office-sightings?owner=&limit=` | | `{ items }` oldest → newest (default 2000, max 5000) |
| `POST /citamate/office-sightings` | `{ items: [sighting] }` (≤ 500) | `{ saved: n }` |
| `DELETE /citamate/office-sightings` | | `{ removed: n }` |

### Catalog
`GET /citamate/catalog` → `{ version: 3, data: { provinces: [...], paises: [...], tramites: {...}, offices: {...} } }`
— exactly the four objects `catalog.js` defines today as `ICP_PROVINCES`, `ICP_PAISES`,
`ICP_TRAMITES`, `ICP_OFFICES`. Seeded from `ext-hub/seeds/citamate-catalog.json`.

### Site config
`bootstrap.siteConfig` for citamate holds the page selectors that used to be hard-coded in
`content.js` (keys defined by `ext-hub/seeds/citamate-site-config.json`). The extension must
not run without it.

## RelaySwitch

### Proxy object — RelaySwitch's `ProxyProfile` plus ownership
```json
{ "id": "…", "name": "DE residential", "scheme": "http", "host": "1.2.3.4", "port": 8080,
  "usernameTemplate": "user-session-{session}", "password": "…",
  "country": "de", "city": "", "sessionStart": 1, "sessionEnd": 1000,
  "ownerId": "…", "ownerName": "ali", "createdAt": 0, "updatedAt": 0 }
```
`scheme` ∈ http|https|socks4|socks5; `host` required; `port` 1–65535. Password is encrypted
at rest and returned in clear only to the owner/admin.

| Method & path | Body | 200 |
|---|---|---|
| `GET /relayswitch/proxies?owner=` | | `{ items }` (sorted by name) |
| `POST /relayswitch/proxies` | proxy fields | `{ item }` (201) |
| `POST /relayswitch/proxies/bulk` | `{ items }` (≤ 1000) | `{ items }` (201) |
| `PUT /relayswitch/proxies/:id` | proxy fields | `{ item }` |
| `DELETE /relayswitch/proxies/:id` | | `{ ok: true }` (also deletes its checks) |

### Checks (score history)
Check object = RelaySwitch's `CheckResult` + `proxyId`:
`{ id?, proxyId, t, ok, ms?, ip?, error?, source: "test"|"use" }` — optional client `id`
de-duplicates a batch that is sent twice (same rule for RelaySwitch logs).

| Method & path | Body | 200 |
|---|---|---|
| `GET /relayswitch/checks?owner=` | | `{ stats: { "<proxyId>": { results: [check without proxyId] } } }` (last 50 per proxy, oldest → newest) |
| `POST /relayswitch/checks` | `{ items: [check] }` (≤ 500) | `{ saved: n }` (unknown / foreign proxyIds ignored) |

### Logs
Log object = RelaySwitch's `LogEntry`: `{ id?, t, level, event, profile?, profileId?, detail? }`.

| Method & path | Body | 200 |
|---|---|---|
| `GET /relayswitch/logs?owner=&limit=` | | `{ items }` oldest → newest (default 2000, max 5000) |
| `POST /relayswitch/logs` | `{ items: [log] }` (≤ 500) | `{ saved: n }` |
| `DELETE /relayswitch/logs` | | `{ removed: n }` |

## Devices

Device object: `{ id, deviceId, ext, name, version, lastSeenAt, createdAt, revoked, ownerId, ownerName }`

| Method & path | 200 |
|---|---|
| `GET /devices?owner=` | `{ items }` |
| `DELETE /devices/:id` | `{ ok: true }` — revokes the device and signs it out (own device, or admin) |

## Dashboard
`GET /dashboard?owner=` → `{ counts: { profiles, proxies, devices, logs7d, bookings7d }, entitlements: [...] }`
(admin with `owner=all` gets totals plus `users`).

## Admin (role `admin` only, panel)

| Method & path | Body | 200 |
|---|---|---|
| `GET /admin/users` | | `{ items: [user + { enabled, pending, note, createdAt, lastLoginAt, entitlements }] }` |
| `POST /admin/users` | `{ username, password, email?, role?, note?, entitlements? }` | `{ item }` (201) |
| `PUT /admin/users/:id` | any of `{ username, email, role, enabled, pending, note, password }` | `{ item }` |
| `DELETE /admin/users/:id` | | `{ ok: true }` (deletes their data too; cannot delete yourself) |
| `POST /admin/users/:id/sign-out` | | `{ ok: true }` (revokes all sessions) |
| `PUT /admin/users/:id/entitlements` | `{ items: [{ ext, expiresAt (ms or null = never), maxDevices }] }` | `{ items }` (replaces the set) |
| `GET /admin/settings` | | `{ values: { allowSignup, minVersion: {citamate, relayswitch}, enabled: {citamate, relayswitch}, logRetentionDays } }` |
| `PUT /admin/settings` | partial `values` | `{ values }` |
| `GET /admin/catalog/citamate` | | `{ version, data, updatedAt }` |
| `PUT /admin/catalog/citamate` | `{ data }` | `{ version }` (bumps the version) |
| `GET /admin/site-config/:ext` | | `{ config, updatedAt }` |
| `PUT /admin/site-config/:ext` | `{ config }` | `{ config }` |
| `GET /admin/audit?limit=&before=` | | `{ items: [{ id, t, actorId, actorName, action, target, detail, ip }] }` newest first |

## Panel hosting
The web panel is served by the same server at `/` (`/login`, `/app`), same origin as the API,
so it needs no CORS. It signs in with `client.kind = "panel"`, keeps the access token in
memory and the refresh token in the HttpOnly, `SameSite=Strict` cookie `eh_rt`
(path `/api/v1/auth`).
