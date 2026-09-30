import type { Migration, MigrationDb } from '../migrate.ts';

/** Remove invite email identity without expanding the scope of old bound codes. */
export const emailFreeInvitesMigration: Migration = {
  id: '0006-email-free-invites',
  async up(db: MigrationDb): Promise<void> {
    // Only the dev server's existing unbound codes can survive this change.
    // An email-bound code must not silently become usable by anyone holding it.
    await db.exec("DELETE FROM invites WHERE email <> '*'");
    await db.exec('ALTER TABLE invites DROP COLUMN email');
  },
};
