import { caseFoldKey } from '../case-fold.ts';
import type { Migration } from '../migrate.ts';

export const unicodePresetEmailKeysMigration: Migration = {
  id: '0009-unicode-preset-email-keys',
  async up(db): Promise<void> {
    await db.exec(`
      CREATE TABLE presets_unicode (
        id TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 24),
        name TEXT NOT NULL,
        name_key TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        fields TEXT NOT NULL CHECK (json_valid(fields)),
        extra TEXT CHECK (extra IS NULL OR json_valid(extra)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    await db.exec(`
      CREATE TABLE users_unicode (
        id TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 24),
        email TEXT,
        email_key TEXT,
        role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
        file_access INTEGER CHECK (file_access IS NULL OR file_access IN (0, 1)),
        created_at TEXT NOT NULL,
        last_seen_at TEXT,
        CHECK ((email IS NULL) = (email_key IS NULL))
      );
    `);
    const presets = await db.all<{ id: string; name: string }>('SELECT id, name FROM presets');
    for (const row of presets) {
      await db.run(
        `INSERT INTO presets_unicode
           (id, name, name_key, schema_version, fields, extra, created_at, updated_at)
         SELECT id, name, ?, schema_version, fields, extra, created_at, updated_at
           FROM presets WHERE id = ?`,
        [caseFoldKey(row.name), row.id],
      );
    }
    const users = await db.all<{ id: string; email: string | null }>('SELECT id, email FROM users');
    for (const row of users) {
      await db.run(
        `INSERT INTO users_unicode (id, email, email_key, role, file_access, created_at, last_seen_at)
         SELECT id, email, ?, role, file_access, created_at, last_seen_at FROM users WHERE id = ?`,
        [row.email === null ? null : caseFoldKey(row.email), row.id],
      );
    }
    // Bun's multi-statement exec can hide an intermediate constraint failure; create each unique index separately.
    await db.exec('DROP TABLE presets');
    await db.exec('ALTER TABLE presets_unicode RENAME TO presets');
    await db.run('CREATE UNIQUE INDEX presets_name_unique ON presets (name_key)');
    await db.exec('DROP TABLE users');
    await db.exec('ALTER TABLE users_unicode RENAME TO users');
    await db.run(
      'CREATE UNIQUE INDEX users_email_unique ON users (email_key) WHERE email_key IS NOT NULL',
    );
    const violations = await db.all('PRAGMA foreign_key_check');
    if (violations.length > 0) throw new Error('Unicode identity migration violated foreign keys');
  },
};
