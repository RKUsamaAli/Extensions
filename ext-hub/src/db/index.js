'use strict';
/**
 * SQLite (better-sqlite3, WAL). openDb(file) opens, tunes and migrates.
 * Migrations are the numbered .sql files in ./migrations, applied once each, in order,
 * inside a transaction. Keep later migrations additive so a rollback of the app still works.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function openDb(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.pragma('temp_store = MEMORY');
    migrate(db);
    return db;
}

function migrate(db) {
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
    const done = new Set(db.prepare('SELECT name FROM schema_migrations').pluck().all());
    const files = fs
        .readdirSync(MIGRATIONS_DIR)
        .filter((f) => /^\d+_.+\.sql$/.test(f))
        .sort();
    const applied = [];
    for (const f of files) {
        if (done.has(f)) continue;
        const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
        db.transaction(() => {
            db.exec(sql);
            db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(f, Date.now());
        })();
        applied.push(f);
    }
    return applied;
}

module.exports = { openDb, migrate };
