-- =============================================================================
-- ext-hub - initial schema
--
-- Conventions:
--   id          TEXT PRIMARY KEY   UUID v7 (random but creation-ordered)
--   created_at / updated_at        UTC epoch milliseconds
--   created_by / updated_by        users.id of who did it, NULL = system
--   owner_id                       the user the data belongs to. Users only see
--                                  their own rows, admins see all (enforced in services).
--   *_enc                          AES-256-GCM ciphertext (src/lib/crypto.js)
-- =============================================================================

CREATE TABLE users (
    id             TEXT PRIMARY KEY,
    username       TEXT NOT NULL UNIQUE COLLATE NOCASE,
    email          TEXT,
    password_hash  TEXT NOT NULL,
    role           TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
    enabled        INTEGER NOT NULL DEFAULT 1,
    pending        INTEGER NOT NULL DEFAULT 0,          -- self sign-up waiting for approval
    token_version  INTEGER NOT NULL DEFAULT 1,          -- bump = every token of the user dies
    note           TEXT,
    last_login_at  INTEGER,
    created_at     INTEGER NOT NULL,
    created_by     TEXT,
    updated_at     INTEGER NOT NULL,
    updated_by     TEXT
);

-- Which extension a user may use, until when, on how many devices.
CREATE TABLE entitlements (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ext          TEXT NOT NULL CHECK (ext IN ('citamate', 'relayswitch')),
    expires_at   INTEGER,                                -- NULL = never expires
    max_devices  INTEGER NOT NULL DEFAULT 1,
    created_at   INTEGER NOT NULL,
    created_by   TEXT,
    updated_at   INTEGER NOT NULL,
    updated_by   TEXT,
    UNIQUE (user_id, ext)
);

-- One row per extension install (deviceId is created by the extension once).
CREATE TABLE devices (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ext           TEXT NOT NULL,
    device_id     TEXT NOT NULL,
    name          TEXT,
    version       TEXT,
    last_seen_at  INTEGER,
    revoked       INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL,
    created_by    TEXT,
    updated_at    INTEGER NOT NULL,
    updated_by    TEXT,
    UNIQUE (user_id, ext, device_id)
);

-- A sign-in: holds the hash of the refresh token. Access tokens carry its id (sid).
CREATE TABLE auth_sessions (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind            TEXT NOT NULL CHECK (kind IN ('extension', 'panel')),
    ext             TEXT,
    device_row_id   TEXT REFERENCES devices(id) ON DELETE CASCADE,
    token_hash      TEXT NOT NULL UNIQUE,
    expires_at      INTEGER NOT NULL,
    revoked_at      INTEGER,
    last_used_at    INTEGER,
    ip              TEXT,
    user_agent      TEXT,
    created_at      INTEGER NOT NULL,
    created_by      TEXT,
    updated_at      INTEGER NOT NULL,
    updated_by      TEXT
);
CREATE INDEX idx_auth_sessions_user ON auth_sessions(user_id);
CREATE INDEX idx_auth_sessions_device ON auth_sessions(device_row_id);

-- CitaMate entries. label stays readable for sorting; everything else (names,
-- document numbers, phone, email ...) is one encrypted JSON blob.
CREATE TABLE profiles (
    id          TEXT PRIMARY KEY,
    owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label       TEXT NOT NULL,
    data_enc    TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    created_by  TEXT,
    updated_at  INTEGER NOT NULL,
    updated_by  TEXT
);
CREATE INDEX idx_profiles_owner ON profiles(owner_id);

CREATE TABLE cm_logs (
    id          TEXT PRIMARY KEY,
    owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_id   TEXT NOT NULL,
    t           INTEGER NOT NULL,
    page        TEXT,
    url         TEXT,
    kind        TEXT,
    entry       TEXT,
    entry_id    TEXT,
    action      TEXT,
    status      TEXT,
    detail      TEXT,
    created_at  INTEGER NOT NULL,
    UNIQUE (owner_id, client_id)
);
CREATE INDEX idx_cm_logs_owner_t ON cm_logs(owner_id, t);
CREATE INDEX idx_cm_logs_t ON cm_logs(t);

CREATE TABLE cm_sightings (
    id            TEXT PRIMARY KEY,
    owner_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_id     TEXT NOT NULL,
    t             INTEGER NOT NULL,
    entry         TEXT,
    entry_id      TEXT,
    province      TEXT,
    tramite       TEXT,
    kind          TEXT,
    offices_json  TEXT NOT NULL DEFAULT '[]',
    created_at    INTEGER NOT NULL,
    UNIQUE (owner_id, client_id)
);
CREATE INDEX idx_cm_sightings_owner_t ON cm_sightings(owner_id, t);
CREATE INDEX idx_cm_sightings_t ON cm_sightings(t);

-- RelaySwitch proxies. The password is encrypted.
CREATE TABLE proxies (
    id                 TEXT PRIMARY KEY,
    owner_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name               TEXT NOT NULL DEFAULT '',
    scheme             TEXT NOT NULL CHECK (scheme IN ('http', 'https', 'socks4', 'socks5')),
    host               TEXT NOT NULL,
    port               INTEGER NOT NULL,
    username_template  TEXT NOT NULL DEFAULT '',
    password_enc       TEXT,
    country            TEXT NOT NULL DEFAULT '',
    city               TEXT NOT NULL DEFAULT '',
    session_start      INTEGER NOT NULL DEFAULT 1,
    session_end        INTEGER NOT NULL DEFAULT 1000,
    created_at         INTEGER NOT NULL,
    created_by         TEXT,
    updated_at         INTEGER NOT NULL,
    updated_by         TEXT
);
CREATE INDEX idx_proxies_owner ON proxies(owner_id);

CREATE TABLE proxy_checks (
    id          TEXT PRIMARY KEY,
    owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    proxy_id    TEXT NOT NULL REFERENCES proxies(id) ON DELETE CASCADE,
    client_id   TEXT,                                    -- optional id from the extension (de-duplication)
    t           INTEGER NOT NULL,
    ok          INTEGER NOT NULL,
    ms          INTEGER,
    ip          TEXT,
    error       TEXT,
    source      TEXT NOT NULL DEFAULT 'test',
    created_at  INTEGER NOT NULL
);
CREATE INDEX idx_proxy_checks_proxy_t ON proxy_checks(proxy_id, t);
CREATE INDEX idx_proxy_checks_t ON proxy_checks(t);
CREATE UNIQUE INDEX idx_proxy_checks_client ON proxy_checks(owner_id, client_id) WHERE client_id IS NOT NULL;

CREATE TABLE rs_logs (
    id          TEXT PRIMARY KEY,
    owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_id   TEXT,                                    -- optional id from the extension (de-duplication)
    t           INTEGER NOT NULL,
    level       TEXT NOT NULL DEFAULT 'info',
    event       TEXT NOT NULL,
    profile     TEXT,
    profile_id  TEXT,
    detail      TEXT,
    created_at  INTEGER NOT NULL
);
CREATE INDEX idx_rs_logs_owner_t ON rs_logs(owner_id, t);
CREATE INDEX idx_rs_logs_t ON rs_logs(t);
CREATE UNIQUE INDEX idx_rs_logs_client ON rs_logs(owner_id, client_id) WHERE client_id IS NOT NULL;

-- Versioned reference data (CitaMate's provinces / countries / trámites / offices).
CREATE TABLE catalogs (
    ext         TEXT PRIMARY KEY,
    version     INTEGER NOT NULL,
    data_json   TEXT NOT NULL,
    updated_at  INTEGER NOT NULL,
    updated_by  TEXT
);

-- Per-extension JSON the extension needs to work (e.g. CitaMate's page selectors).
CREATE TABLE site_configs (
    ext          TEXT PRIMARY KEY,
    config_json  TEXT NOT NULL,
    updated_at   INTEGER NOT NULL,
    updated_by   TEXT
);

CREATE TABLE settings (
    key         TEXT PRIMARY KEY,
    value_json  TEXT NOT NULL,
    updated_at  INTEGER NOT NULL,
    updated_by  TEXT
);

-- Who did what (sign-ins, admin changes, device removals ...).
CREATE TABLE audit (
    id          TEXT PRIMARY KEY,
    t           INTEGER NOT NULL,
    actor_id    TEXT,
    actor_name  TEXT,
    action      TEXT NOT NULL,
    target      TEXT,
    detail      TEXT,
    ip          TEXT
);
CREATE INDEX idx_audit_t ON audit(t);
