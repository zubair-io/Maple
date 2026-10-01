import { describe, expect, it } from 'bun:test';
import { createBlankTestDatabase } from '../../src/db/sqlite/test-sqlite.test-helpers.ts';
import { runMigrations } from '../../src/db/sqlite/migrate.ts';
import { ALL_MIGRATIONS } from '../../src/db/sqlite/migrations/index.ts';
import { seedCredential, seedUser } from '../helpers/sqlite-fixtures.ts';
import type { Database } from 'bun:sqlite';
import { ObjectId } from '../../src/db/object-id.ts';

function seedLegacyOwner(db: Database): ObjectId {
  const id = new ObjectId();
  db.run(
    "INSERT INTO users (id, email, role, created_at) VALUES (?, 'legacy@maple.test', 'owner', '2026-01-01')",
    [id.toHexString()],
  );
  return id;
}

describe('email-free auth migrations', () => {
  it('preserves existing accounts, passkeys and sessions, then restores foreign-key enforcement', async () => {
    using handle = createBlankTestDatabase();
    await runMigrations(handle.migrationDb, ALL_MIGRATIONS.slice(0, 4));
    const owner = seedLegacyOwner(handle.db);
    const credential = seedCredential(handle.db, { userId: owner, credentialId: 'legacy-passkey' });
    handle.db.run(
      `INSERT INTO refresh_tokens (id, user_id, token_hash, issued_at, expires_at, device_label)
      VALUES (?, ?, 'legacy-refresh', '2026-01-01', '2027-01-01', 'Legacy device')`,
      ['1'.repeat(24), owner.toHexString()],
    );
    for (const [id, code, email] of [
      ['2', 'BOUNDCOD', 'invitee@maple.test'],
      ['3', 'UNBOUNDC', '*'],
    ]) {
      handle.db.run(
        `INSERT INTO invites (id, code, email, invited_by, expires_at) VALUES (?, ?, ?, ?, ?)`,
        [id!.repeat(24), code!, email!, owner.toHexString(), '2027-01-01'],
      );
    }
    await runMigrations(handle.migrationDb, ALL_MIGRATIONS);
    expect(
      handle.db.query('SELECT email FROM users WHERE id = ?').get(owner.toHexString()),
    ).toEqual({ email: 'legacy@maple.test' });
    expect(
      handle.db
        .query('SELECT credential_id FROM credentials WHERE id = ?')
        .get(credential.toHexString()),
    ).toEqual({ credential_id: 'legacy-passkey' });
    expect(handle.db.query('SELECT COUNT(*) AS n FROM refresh_tokens').get()).toEqual({ n: 1 });
    expect(handle.db.query('SELECT code FROM invites').all()).toEqual([{ code: 'UNBOUNDC' }]);
    expect(handle.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(handle.db.query('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    expect(
      handle.db
        .query('PRAGMA table_info(invites)')
        .all()
        .some((r) => (r as { name: string }).name === 'email'),
    ).toBe(false);
    seedUser(handle.db, { email: null, role: 'member' });
    seedUser(handle.db, { email: null, role: 'member' });
    expect(() =>
      seedCredential(handle.db, { userId: owner, credentialId: 'another-passkey' }),
    ).not.toThrow();
    handle.db.run('DELETE FROM users WHERE id = ?', [owner.toHexString()]);
    expect(handle.db.query('SELECT COUNT(*) AS n FROM credentials').get()).toEqual({ n: 0 });
    expect(handle.db.query('SELECT COUNT(*) AS n FROM refresh_tokens').get()).toEqual({ n: 0 });
  });

  it('rolls back a broken rebuild and restores enforcement on failure', async () => {
    using handle = createBlankTestDatabase();
    await runMigrations(handle.migrationDb, ALL_MIGRATIONS.slice(0, 4));
    const owner = seedLegacyOwner(handle.db);
    seedCredential(handle.db, { userId: owner, credentialId: 'legacy-passkey' });
    handle.db.exec('PRAGMA foreign_keys = OFF');
    handle.db.run('DELETE FROM users WHERE id = ?', [owner.toHexString()]);
    handle.db.exec('PRAGMA foreign_keys = ON');
    await expect(runMigrations(handle.migrationDb, ALL_MIGRATIONS)).rejects.toThrow(
      'user migration violated foreign keys',
    );
    expect(handle.db.query('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    expect(handle.db.query('SELECT COUNT(*) AS n FROM credentials').get()).toEqual({ n: 1 });
    expect(handle.db.query("SELECT id FROM schema_migrations WHERE id LIKE '0005%'").all()).toEqual(
      [],
    );
  });
});
