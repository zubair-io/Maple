import type { Migration, MigrationDb } from '../migrate.ts';

/** 0032 — keep the sidecar a compare-and-swap backup re-send displaced when the
 * device's edit was based on an older version, so the newer edit can land
 * without losing the one it replaced (#4719). Edit history (#4983) builds on it. */
export const sidecarDivergencesMigration: Migration = {
  id: '0032-sidecar-divergences',
  async up(db: MigrationDb): Promise<void> {
    await db.exec(`CREATE TABLE sidecar_divergences (
      id               TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 24),
      asset_id         TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      library_id       TEXT NOT NULL,
      sidecar_rel_path TEXT NOT NULL,
      device_id        TEXT NOT NULL,
      base_sha256      TEXT,
      displaced_sha256 TEXT NOT NULL,
      displaced_xmp    TEXT NOT NULL,
      incoming_sha256  TEXT NOT NULL,
      created_at       TEXT NOT NULL
    )`);
    await db.exec(`CREATE INDEX sidecar_divergences_asset ON sidecar_divergences(asset_id)`);
  },
};
