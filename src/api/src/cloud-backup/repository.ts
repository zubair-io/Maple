import { sqliteDb, type SqliteDb } from '../db/repos/db-handle.ts';
import type { BackupManifest, BackupObject, UploadCheckpoint, PurgeRecord } from './provider.ts';

export interface BackupDestination {
  id: string;
  libraryId: string;
  kind: 'folder' | 'google-drive';
  name: string;
  enabled: boolean;
  generation: number;
  path: string | null;
  rootId: string | null;
  accountId: string | null;
}
export interface BackupEntry {
  id: string;
  destination_id: string;
  asset_id: string;
  ordinal: number;
  sequence: number;
  state: 'active' | 'trash' | 'purged';
  source_path: string;
  manifest: string | null;
  snapshot_hash: string | null;
  verified_sequence: number;
  attempts: number;
  retry_at: number;
  last_error: string | null;
  lease_owner: string | null;
  lease_until: number;
}
const DESTINATION_COLUMNS = `id,library_id AS libraryId,kind,name,enabled,generation,
  path,root_id AS rootId,account_id AS accountId`;
export class BackupRepository {
  constructor(private readonly override?: SqliteDb) {}
  get db(): SqliteDb {
    return sqliteDb(this.override);
  }
  async destinations(): Promise<BackupDestination[]> {
    const rows = await this.db.read<BackupDestination>(
      `SELECT ${DESTINATION_COLUMNS} FROM backup_destinations`,
    );
    return rows.map((row) => ({ ...row, enabled: Boolean(row.enabled) }));
  }
  async destination(id: string): Promise<BackupDestination | null> {
    return (await this.destinations()).find((row) => row.id === id) ?? null;
  }
  async createDestination(
    value: Pick<BackupDestination, 'libraryId' | 'kind' | 'name' | 'path'>,
  ): Promise<BackupDestination> {
    const id = crypto.randomUUID();
    await this.db.write(
      `INSERT INTO backup_destinations(id,library_id,kind,name,path,created_at)
      VALUES(?,?,?,?,?,?)`,
      [id, value.libraryId, value.kind, value.name, value.path, new Date().toISOString()],
    );
    await this.rearmLibrary(value.libraryId);
    return (await this.destination(id))!;
  }
  async updateDestination(
    id: string,
    patch: { enabled?: boolean; name?: string; path?: string },
  ): Promise<void> {
    const fields = Object.entries(patch).filter(([, value]) => value !== undefined);
    if (!fields.length) return;
    await this.db.write(
      `UPDATE backup_destinations SET ${fields.map(([key]) => `${key}=?`).join(',')},
      generation=generation+1 WHERE id=?`,
      [...fields.map(([, v]) => (typeof v === 'boolean' ? Number(v) : v!)), id],
    );
    const dest = await this.destination(id);
    if (dest) await this.rearmLibrary(dest.libraryId);
  }
  // fallow-ignore-next-line unused-class-member
  async attachGoogleRoot(
    id: string,
    rootId: string,
    accountId: string,
    generation: number,
  ): Promise<boolean> {
    const result = await this.db.write(
      `UPDATE backup_destinations SET root_id=?,account_id=?,generation=generation+1
      WHERE id=? AND kind='google-drive' AND generation=? AND (root_id IS NULL OR root_id=?)
      AND (account_id IS NULL OR account_id=?)
      AND NOT EXISTS (SELECT 1 FROM backup_destinations other
        WHERE other.kind='google-drive' AND other.root_id=? AND other.id<>?)`,
      [rootId, accountId, id, generation, rootId, accountId, rootId, id],
    );
    return result.changes === 1;
  }
  async rearmLibrary(libraryId: string): Promise<void> {
    await this.db.write(
      `UPDATE stage_state SET version=0,attempts=0,dead=0,next_attempt_at=NULL
      WHERE stage='cloud-backup' AND asset_id IN (SELECT asset_id FROM asset_locations WHERE library_id=?)`,
      [libraryId],
    );
  }
  async entries(destinationId: string, assetId?: string): Promise<BackupEntry[]> {
    return this.db.read<BackupEntry>(
      `SELECT * FROM backup_entries WHERE destination_id=?${assetId ? ' AND asset_id=?' : ''}`,
      assetId ? [destinationId, assetId] : [destinationId],
    );
  }
  async ensureEntry(
    destinationId: string,
    assetId: string,
    ordinal: number,
    sourcePath: string,
  ): Promise<BackupEntry> {
    await this.db.write(
      `INSERT INTO backup_entries(id,destination_id,asset_id,ordinal,source_path)
      SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM backup_destinations WHERE id=?)
      AND EXISTS (SELECT 1 FROM assets WHERE id=?) AND NOT EXISTS
      (SELECT 1 FROM backup_lifecycle WHERE asset_id=? AND kind='purge')
      AND NOT EXISTS (SELECT 1 FROM backup_lifecycle l JOIN backup_destinations d
        ON d.library_id=l.library_id WHERE d.id=? AND l.phase='prepared'
        AND l.target_path=? AND l.asset_id!=?)
      ON CONFLICT(destination_id,asset_id,ordinal) DO NOTHING`,
      [
        crypto.randomUUID(),
        destinationId,
        assetId,
        ordinal,
        sourcePath,
        destinationId,
        assetId,
        assetId,
        destinationId,
        sourcePath,
        assetId,
      ],
    );
    const rows = await this.db.read<BackupEntry>(
      `SELECT * FROM backup_entries WHERE destination_id=? AND asset_id=? AND ordinal=?`,
      [destinationId, assetId, ordinal],
    );
    if (!rows[0])
      throw new Error('Backup destination or asset no longer exists, or asset was purged');
    return rows[0];
  }
  async claim(entry: BackupEntry, owner: string): Promise<boolean> {
    const result = await this.db.write(
      `UPDATE backup_entries SET lease_owner=?,lease_until=?
      WHERE id=? AND sequence=? AND state!='purged' AND retry_at<=? AND lease_until<?
      AND EXISTS (SELECT 1 FROM backup_destinations
        WHERE id=backup_entries.destination_id AND enabled=1)
      AND NOT EXISTS (SELECT 1 FROM backup_lifecycle l JOIN backup_destinations d
        ON d.library_id=l.library_id WHERE d.id=backup_entries.destination_id
        AND l.asset_id=backup_entries.asset_id AND l.phase='prepared')
      AND NOT EXISTS (SELECT 1 FROM backup_lifecycle WHERE asset_id=backup_entries.asset_id AND kind='purge')
      AND NOT EXISTS (SELECT 1 FROM backup_lifecycle l JOIN backup_destinations d
        ON d.library_id=l.library_id WHERE d.id=backup_entries.destination_id AND l.phase='prepared'
        AND l.target_path=backup_entries.source_path AND l.asset_id!=backup_entries.asset_id)`,
      [owner, Date.now() + 120_000, entry.id, entry.sequence, Date.now(), Date.now()],
    );
    return result.changes > 0;
  }
  async reserveSnapshot(entry: BackupEntry, owner: string, hash: string): Promise<BackupEntry> {
    await this.db.write(
      `UPDATE backup_entries SET sequence=sequence+CASE WHEN snapshot_hash IS NULL THEN 0 ELSE 1 END,
      snapshot_hash=? WHERE id=? AND sequence=? AND lease_owner=? AND lease_until>? AND state!='purged' AND snapshot_hash IS NOT ?`,
      [hash, entry.id, entry.sequence, owner, Date.now(), hash],
    );
    const rows = await this.db.read<BackupEntry>(`SELECT * FROM backup_entries WHERE id=?`, [
      entry.id,
    ]);
    return rows[0]!;
  }
  async fence(entry: BackupEntry, destination: BackupDestination, owner: string): Promise<boolean> {
    const result = await this.db.write(
      `UPDATE backup_entries SET lease_until=? WHERE id=? AND sequence=?
      AND lease_owner=? AND lease_until>? AND state!='purged' AND EXISTS
      (SELECT 1 FROM backup_destinations WHERE id=? AND enabled=1 AND generation=?)
      AND NOT EXISTS (SELECT 1 FROM backup_lifecycle l WHERE l.asset_id=backup_entries.asset_id
        AND ((l.phase='prepared' AND l.library_id=?) OR l.kind='purge'))
      AND NOT EXISTS (SELECT 1 FROM backup_lifecycle l JOIN backup_destinations d
        ON d.library_id=l.library_id WHERE d.id=backup_entries.destination_id AND l.phase='prepared'
        AND l.target_path=backup_entries.source_path AND l.asset_id!=backup_entries.asset_id)`,
      [
        Date.now() + 120_000,
        entry.id,
        entry.sequence,
        owner,
        Date.now(),
        destination.id,
        destination.generation,
        destination.libraryId,
      ],
    );
    return result.changes > 0;
  }
  async finish(
    entry: BackupEntry,
    destination: BackupDestination,
    owner: string,
    manifest: BackupManifest,
  ): Promise<boolean> {
    const result = await this.db.write(
      `UPDATE backup_entries SET manifest=?,verified_sequence=?,source_path=?,
      state=?,attempts=0,retry_at=0,last_error=NULL,lease_owner=NULL,lease_until=0
      WHERE id=? AND sequence=? AND lease_owner=? AND lease_until>? AND state!='purged'
      AND EXISTS (SELECT 1 FROM backup_destinations WHERE id=? AND enabled=1 AND generation=?)
      AND NOT EXISTS (SELECT 1 FROM backup_lifecycle WHERE asset_id=backup_entries.asset_id
        AND ((library_id=? AND phase='prepared') OR kind='purge'))
      AND NOT EXISTS (SELECT 1 FROM backup_lifecycle l JOIN backup_destinations d
        ON d.library_id=l.library_id WHERE d.id=backup_entries.destination_id AND l.phase='prepared'
        AND l.target_path=backup_entries.source_path AND l.asset_id!=backup_entries.asset_id)`,
      [
        JSON.stringify(manifest),
        entry.sequence,
        manifest.currentPath,
        manifest.state,
        entry.id,
        entry.sequence,
        owner,
        Date.now(),
        destination.id,
        destination.generation,
        destination.libraryId,
      ],
    );
    return result.changes > 0;
  }
  async fail(entry: BackupEntry, owner: string, error: string): Promise<void> {
    await this.db.write(
      `UPDATE backup_entries SET attempts=attempts+1,retry_at=?,last_error=?,lease_owner=NULL,lease_until=0
      WHERE id=? AND lease_owner=?`,
      [
        Date.now() + Math.min(3_600_000, 5000 * 2 ** Math.min(entry.attempts, 10)),
        error.slice(0, 300),
        entry.id,
        owner,
      ],
    );
  }
  async object(
    destinationId: string,
    key: string,
  ): Promise<{
    object: BackupObject | null;
    checkpoint: UploadCheckpoint | null;
  }> {
    const rows = await this.db.read<{
      object: string | null;
      checkpoint: string | null;
    }>(`SELECT object,checkpoint FROM backup_objects WHERE destination_id=? AND key=?`, [
      destinationId,
      key,
    ]);
    return {
      object: rows[0]?.object ? JSON.parse(rows[0].object) : null,
      checkpoint: rows[0]?.checkpoint ? JSON.parse(rows[0].checkpoint) : null,
    };
  }
  async objectOwner(
    destinationId: string,
    key: string,
  ): Promise<{ entryId: string; object: BackupObject | null } | null> {
    const rows = await this.db.read<{
      entry_id: string;
      object: string | null;
    }>(`SELECT entry_id,object FROM backup_objects WHERE destination_id=? AND key=?`, [
      destinationId,
      key,
    ]);
    const row = rows[0];
    return row
      ? {
          entryId: row.entry_id,
          object: row.object ? JSON.parse(row.object) : null,
        }
      : null;
  }
  async objectsForEntry(destinationId: string, entryId: string): Promise<BackupObject[]> {
    const rows = await this.db.read<{ object: string }>(
      `SELECT object FROM backup_objects WHERE destination_id=? AND entry_id=? AND object IS NOT NULL`,
      [destinationId, entryId],
    );
    return rows.map((row) => JSON.parse(row.object) as BackupObject);
  }
  async saveObject(
    destinationId: string,
    entryId: string,
    key: string,
    object: BackupObject | null,
    checkpoint: UploadCheckpoint | null,
  ): Promise<void> {
    await this.db.transaction([
      {
        sql: `INSERT INTO backup_objects(destination_id,key,entry_id,object,checkpoint) VALUES(?,?,?,?,?)
      ON CONFLICT(destination_id,key) DO UPDATE SET entry_id=excluded.entry_id,
      object=COALESCE(excluded.object,object),checkpoint=excluded.checkpoint`,
        params: [
          destinationId,
          key,
          entryId,
          object ? JSON.stringify(object) : null,
          checkpoint ? JSON.stringify(checkpoint) : null,
        ],
      },
      {
        sql: `UPDATE backup_purges SET completed=0,revision=revision+1 WHERE destination_id=? AND entry_id=?`,
        params: [destinationId, entryId],
      },
    ]);
  }
  // fallow-ignore-next-line unused-class-member
  async reconcileObject(
    destinationId: string,
    entryId: string,
    key: string,
    object: BackupObject,
  ): Promise<void> {
    await this.db.write(
      `UPDATE backup_objects SET object=?,checkpoint=NULL
      WHERE destination_id=? AND entry_id=? AND key=?`,
      [JSON.stringify(object), destinationId, entryId, key],
    );
  }
  async forgetObject(destinationId: string, key: string, locator: string): Promise<void> {
    await this.db.write(
      `DELETE FROM backup_objects WHERE destination_id=? AND key=?
      AND json_extract(object,'$.locator')=?`,
      [destinationId, key, locator],
    );
  }
  async purges(destinationId: string): Promise<
    Array<{
      entry_id: string;
      record: string;
      published: number;
      completed: number;
      revision: number;
      last_error: string | null;
    }>
  > {
    return this.db.read(`SELECT * FROM backup_purges WHERE destination_id=?`, [destinationId]);
  }
  async retry(id: string): Promise<void> {
    await this.db.write(
      `UPDATE backup_entries SET retry_at=0,attempts=0,last_error=NULL WHERE destination_id=?`,
      [id],
    );
    const destination = await this.destination(id);
    if (destination) await this.rearmLibrary(destination.libraryId);
  }
  async catalog(id: string): Promise<{ entries: BackupManifest[]; purges: PurgeRecord[] }> {
    const entries = await this.entries(id);
    const purges = await this.purges(id);
    return {
      entries: entries
        .filter((e) => e.state !== 'purged' && e.manifest)
        .map((e) => JSON.parse(e.manifest!)),
      purges: purges.map((p) => JSON.parse(p.record)),
    };
  }
}
