-- Office availability shared across all users: "open since" streaks on sightings, one alert
-- per province + trámite per clock minute, per-user watches, and short check claims.
ALTER TABLE cm_sightings ADD COLUMN page TEXT;
ALTER TABLE cm_sightings ADD COLUMN open_since INTEGER;
ALTER TABLE cm_sightings ADD COLUMN since_json TEXT;
CREATE INDEX idx_cm_sightings_pair_t ON cm_sightings(province, tramite, t);

CREATE TABLE cm_alerts (
    id           TEXT PRIMARY KEY,
    t            INTEGER NOT NULL,
    minute       INTEGER NOT NULL,           -- floor(t / 60000): at most one alert per pair per clock minute
    province     TEXT NOT NULL,
    tramite      TEXT NOT NULL,
    offices_json TEXT NOT NULL,              -- [{ value, text, since }]
    new_json     TEXT NOT NULL DEFAULT '[]', -- offices that appeared in this sighting
    open_since   INTEGER,
    sighting_id  TEXT,
    created_at   INTEGER NOT NULL,
    UNIQUE (province, tramite, minute)
);
CREATE INDEX idx_cm_alerts_t ON cm_alerts(t);

CREATE TABLE cm_watches (
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    province   TEXT NOT NULL,
    tramite    TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, province, tramite)
);

CREATE TABLE cm_check_claims (
    province   TEXT NOT NULL,
    tramite    TEXT NOT NULL,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    entry_id   TEXT,
    until      INTEGER NOT NULL,
    PRIMARY KEY (province, tramite)
);

ALTER TABLE users ADD COLUMN alerts_seen_at INTEGER;
