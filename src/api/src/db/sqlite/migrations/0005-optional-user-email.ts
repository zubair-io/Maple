import type { Migration, MigrationDb } from '../migrate.ts';

/** Permit passkey-only accounts while retaining email on pre-existing users. */
export const optionalUserEmailMigration: Migration = {
  id: '0005-optional-user-email',
  async up(db: MigrationDb): Promise<void> {
    // Foreign keys are disabled by the runner before BEGIN. Keep child
    // references naming `users` throughout the rebuild.
    await db.exec(`
      CREATE TABLE users_email_optional (
        id TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 24),
        email TEXT COLLATE NOCASE,
        role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
        file_access INTEGER CHECK (file_access IS NULL OR file_access IN (0, 1)),
        created_at TEXT NOT NULL,
        last_seen_at TEXT
      );
      INSERT INTO users_email_optional (id, email, role, file_access, created_at, last_seen_at)
        SELECT id, email, role, file_access, created_at, last_seen_at FROM users;
      DROP TABLE users;
      ALTER TABLE users_email_optional RENAME TO users;
      CREATE UNIQUE INDEX users_email_unique ON users (email COLLATE NOCASE)
        WHERE email IS NOT NULL;
    `);
    const violations = await db.all('PRAGMA foreign_key_check');
    if (violations.length > 0) throw new Error('user migration violated foreign keys');
  },
};
