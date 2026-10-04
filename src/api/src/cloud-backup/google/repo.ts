import { GoogleConnectionError } from './config.ts';
import { sqliteDb } from '../../db/repos/db-handle.ts';
import { DEFAULT_GOOGLE_CONFIG, type GoogleConfig } from './config.ts';
import { seal, unseal } from './secrets.ts';

export const GOOGLE_BACKUP_DDL = `
CREATE TABLE backup_google_connections (
  destination_id TEXT PRIMARY KEY, epoch INTEGER NOT NULL DEFAULT 0,
  credentials TEXT NOT NULL, refresh_owner TEXT, refresh_until INTEGER NOT NULL DEFAULT 0,
  pending_root_id TEXT
) WITHOUT ROWID;
CREATE TABLE backup_google_oauth (
  nonce TEXT PRIMARY KEY, destination_id TEXT NOT NULL, owner_id TEXT NOT NULL,
  epoch INTEGER NOT NULL, expires_at INTEGER NOT NULL, state TEXT NOT NULL,
  cookie_hash TEXT NOT NULL, payload TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX backup_google_oauth_expiry ON backup_google_oauth(expires_at);
`;

export interface Connection {
  epoch: number;
  config: GoogleConfig;
}
export interface PendingFlow {
  nonce: string;
  destinationId: string;
  ownerId: string;
  epoch: number;
  expiresAt: number;
  state: string;
  cookieHash: string;
  verifier: string;
  redirectUri: string;
  callback: string;
}
export async function loadConnection(id: string): Promise<Connection> {
  const [row] = await sqliteDb().read<{ epoch: number; credentials: string }>(
    'SELECT epoch, credentials FROM backup_google_connections WHERE destination_id = ?',
    [id],
  );
  return row
    ? {
        epoch: row.epoch,
        config: await unseal<GoogleConfig>(row.credentials, id),
      }
    : { epoch: 0, config: { ...DEFAULT_GOOGLE_CONFIG } };
}

export async function saveConfig(
  id: string,
  config: GoogleConfig,
  epoch: number,
): Promise<boolean> {
  const encrypted = await seal(config, id);
  const result = await sqliteDb().write(
    `INSERT INTO backup_google_connections
    (destination_id, epoch, credentials) VALUES (?, 1, ?)
    ON CONFLICT(destination_id) DO UPDATE SET epoch = epoch + 1, credentials = excluded.credentials,
    refresh_owner = NULL, refresh_until = 0 WHERE epoch = ?`,
    [id, encrypted, epoch],
  );
  return result.changes === 1;
}
export async function commitTokens(
  id: string,
  config: GoogleConfig,
  epoch: number,
  lease?: string,
) {
  const result = await sqliteDb().write(
    `UPDATE backup_google_connections SET credentials = ?
    WHERE destination_id = ? AND epoch = ?${lease ? ' AND refresh_owner = ? AND refresh_until > ?' : ''}`,
    [await seal(config, id), id, epoch, ...(lease ? [lease, Date.now()] : [])],
  );
  if (result.changes !== 1)
    throw new GoogleConnectionError('Google connection changed; start Connect again.');
}
export async function savePending(flow: PendingFlow): Promise<void> {
  await sqliteDb().transaction([
    {
      sql: 'DELETE FROM backup_google_oauth WHERE expires_at < ?',
      params: [Date.now()],
    },
    {
      sql: `INSERT INTO backup_google_oauth VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        flow.nonce,
        flow.destinationId,
        flow.ownerId,
        flow.epoch,
        flow.expiresAt,
        flow.state,
        flow.cookieHash,
        await seal(flow, `flow:${flow.nonce}`),
      ],
    },
  ]);
}
export async function consumePending(state: string, cookieHash: string): Promise<PendingFlow> {
  const [row] = await sqliteDb().read<{ nonce: string; payload: string }>(
    'SELECT nonce, payload FROM backup_google_oauth WHERE state = ? AND cookie_hash = ? AND expires_at > ?',
    [state, cookieHash, Date.now()],
  );
  if (!row)
    throw new GoogleConnectionError(
      'Google connection expired or browser session mismatched; start Connect again.',
    );
  const removed = await sqliteDb().write(
    `DELETE FROM backup_google_oauth WHERE nonce = ?
    AND state = ? AND cookie_hash = ? AND expires_at > ?`,
    [row.nonce, state, cookieHash, Date.now()],
  );
  if (removed.changes !== 1)
    throw new GoogleConnectionError('Google callback already used; start Connect again.');
  return unseal<PendingFlow>(row.payload, `flow:${row.nonce}`);
}
export async function claimRefresh(id: string, epoch: number, owner: string): Promise<boolean> {
  const result = await sqliteDb().write(
    `UPDATE backup_google_connections SET refresh_owner = ?, refresh_until = ?
    WHERE destination_id = ? AND epoch = ? AND refresh_until < ?`,
    [owner, Date.now() + 60_000, id, epoch, Date.now()],
  );
  return result.changes === 1;
}
export async function releaseRefresh(id: string, owner: string): Promise<void> {
  await sqliteDb().write(
    'UPDATE backup_google_connections SET refresh_owner = NULL, refresh_until = 0 WHERE destination_id = ? AND refresh_owner = ?',
    [id, owner],
  );
}
export async function reserveRoot(id: string, epoch: number, proposed: string): Promise<string> {
  await sqliteDb().write(
    `UPDATE backup_google_connections SET pending_root_id = COALESCE(pending_root_id, ?)
    WHERE destination_id = ? AND epoch = ?`,
    [proposed, id, epoch],
  );
  const [row] = await sqliteDb().read<{
    pending_root_id: string | null;
    epoch: number;
  }>('SELECT pending_root_id, epoch FROM backup_google_connections WHERE destination_id = ?', [id]);
  if (row?.epoch !== epoch || !row.pending_root_id)
    throw new GoogleConnectionError(
      'Connection changed; reconnect before creating a backup folder.',
    );
  return row.pending_root_id;
}
