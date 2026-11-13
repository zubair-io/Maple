/**
 * The operator one-shots' side of the `jobs` table: what their lane relays,
 * and which row a refused insert collided with. Every other verb — create,
 * claim, progress, finish, cancel — is the job repository's own.
 */

import type { OperationKind } from '../schema.ts';
import { sqliteDb, type SqliteDb } from './db-handle.ts';
import {
  ACTIVE_OPERATION_SQL,
  HELD_OPERATIONS_SQL,
  NEXT_OPERATION_SQL,
  WAITING_OPERATION_SQL,
} from './jobs.sql.ts';

export async function nextOperationId(dbOverride?: SqliteDb): Promise<string | null> {
  const rows = await sqliteDb(dbOverride).read<{ id: string }>(NEXT_OPERATION_SQL, []);
  return rows[0]?.id ?? null;
}

export async function heldOperationIds(dbOverride?: SqliteDb): Promise<string[]> {
  const rows = await sqliteDb(dbOverride).read<{ id: string }>(HELD_OPERATIONS_SQL, []);
  return rows.map((row) => row.id);
}

/** The queued or running operation of `kind` on `folderId` (null: not per folder). */
export async function activeOperationId(
  kind: OperationKind,
  folderId: string | null,
  dbOverride?: SqliteDb,
): Promise<string | null> {
  const rows = await sqliteDb(dbOverride).read<{ id: string }>(ACTIVE_OPERATION_SQL, [
    kind,
    folderId,
  ]);
  return rows[0]?.id ?? null;
}

/** The clustering request with exactly this payload that has not started yet. */
export async function waitingOperationId(
  payload: Record<string, unknown>,
  dbOverride?: SqliteDb,
): Promise<string | null> {
  const rows = await sqliteDb(dbOverride).read<{ id: string }>(WAITING_OPERATION_SQL, [
    'people_cluster',
    JSON.stringify(payload),
  ]);
  return rows[0]?.id ?? null;
}
