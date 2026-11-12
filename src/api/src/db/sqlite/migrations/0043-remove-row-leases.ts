import type { Migration } from '../migrate.ts';

/** Temporal's heartbeat decides when a job or import attempt is gone, so nothing reads these leases. */
export const removeRowLeasesMigration: Migration = {
  id: '0043-remove-row-leases',
  async up(db): Promise<void> {
    await db.exec(`
      DROP INDEX jobs_claim;
      ALTER TABLE jobs DROP COLUMN lease_expires_at;
      CREATE INDEX jobs_status ON jobs (status);
      DROP INDEX imports_claim;
      ALTER TABLE imports DROP COLUMN lease_expires_at;
    `);
  },
};
