import type { Migration, MigrationDb } from '../migrate.ts';

/** 0035 — record the issuing browser's client IP on native_auth_codes so
 * `/api/auth/native-code/claim` polling is bound to the issuing host (#4673). */
export const nativeCodeIssuedIpMigration: Migration = {
  id: '0035-native-code-issued-ip',
  async up(db: MigrationDb): Promise<void> {
    await db.exec(`ALTER TABLE native_auth_codes ADD COLUMN issued_ip TEXT`);
  },
};
