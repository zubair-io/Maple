import { caseFoldKey } from '../case-fold.ts';
import type { Migration } from '../migrate.ts';

/** Repair stored keys as well as future writes; never merge identities implicitly (#3980). */
export const greekSigmaIdentityKeysMigration: Migration = {
  id: '0012-greek-sigma-identity-keys',
  async up(db): Promise<void> {
    const identities = [
      { table: 'people', source: 'name', key: 'name_key', active: 'merged_into IS NULL' },
      { table: 'presets', source: 'name', key: 'name_key', active: '1' },
      { table: 'users', source: 'email', key: 'email_key', active: 'email IS NOT NULL' },
    ] as const;
    for (const { table, source, key, active } of identities) {
      const live = await db.all<{ id: string; value: string }>(
        `SELECT id, ${source} AS value FROM ${table} WHERE ${active}`,
      );
      const keys = new Set<string>();
      for (const row of live) {
        const folded = caseFoldKey(row.value);
        if (keys.has(folded)) {
          throw new Error(
            `Greek sigma identity collision in ${table}; resolve duplicate identities before upgrading`,
          );
        }
        keys.add(folded);
      }
      const rows = await db.all<{ id: string; value: string; stored: string }>(
        `SELECT id, ${source} AS value, ${key} AS stored FROM ${table} WHERE ${source} IS NOT NULL`,
      );
      for (const row of rows) {
        const folded = caseFoldKey(row.value);
        if (folded === row.stored) continue;
        await db.run(`UPDATE ${table} SET ${key} = ? WHERE id = ?`, [folded, row.id]);
      }
    }
  },
};
