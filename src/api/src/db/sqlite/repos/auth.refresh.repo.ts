/**
 * `refresh_tokens` — the SQLite port of `auth/refresh_store.ts` (#3751).
 *
 * Every function the Mongo module exports has an equivalent here with the same
 * name, parameters and return type, plus the optional trailing `dbOverride`
 * that is the tests' seam. The crypto helpers come from `auth/tokens.ts`
 * unchanged — they touch no database.
 *
 * ## The rotation is still one atomic step, by a different mechanism
 *
 * On Mongo, rotating a token is a `findOneAndUpdate` that consumes the old
 * token and links its successor in one operation, so a concurrent rotation can
 * never see a revoked-but-unlinked row. The pool here cannot express that
 * directly: a write reports how many rows it changed but returns none of them,
 * and a transaction is a list of statements fixed before the first one runs.
 *
 * So the rotation becomes two statements inside one transaction, in an order
 * that makes the outcome self-evident:
 *
 *   1. Insert the successor, selecting its `user_id`, `device_label`,
 *      `family_id`, `platform` and `secure` straight out of the old row — and
 *      only if that row is still live. A dead or unknown token inserts nothing.
 *   2. Consume the old row and point `replaced_by` at the successor, under the
 *      same liveness predicate.
 *
 * `changes === 1` on the second statement is what says this caller won, the
 * same way `findOneAndUpdate` returning a document did. The two statements
 * cannot be interleaved: the pool has exactly one writer thread and the batch
 * runs inside `BEGIN IMMEDIATE`, so nothing can revoke the old row between
 * them.
 *
 * The order also satisfies the foreign key. `replaced_by` references
 * `refresh_tokens (id)`, and SQLite checks that when the statement runs, so
 * naming a successor that does not exist yet — which is exactly what the Mongo
 * version does with a pre-generated id — would be rejected. Inserting first
 * costs nothing and removes the question.
 *
 * ## Revoking a family is one statement, not two
 *
 * The Mongo version issues two `updateMany` calls: stamp `family_revoked_at`
 * on every member, then stamp `revoked_at` on the live ones. `COALESCE` does
 * both in one pass without touching an already-revoked token's timestamp,
 * which matters because that timestamp is what the grace window measures.
 */

import type { ObjectId } from '../../object-id.ts';
import { newObjectIdHex } from '../../object-id.ts';
import { changesAt, sqliteDb, type SqliteDb } from './db-handle.ts';
import { nowIso, toBool, toHex, toObjectId } from './values.ts';
import {
  RefreshError,
  REFRESH_GRACE_MS,
  type IssuedRefresh,
  type IssueRefreshTokenOptions,
} from '../../../auth/refresh-contract.ts';
import { generateRefreshToken, hashRefreshToken, refreshExpiresAt } from '../../../auth/tokens.ts';

export type { SqliteDb } from './db-handle.ts';

// The error class and the option/result shapes are shared with the Mongo store
// rather than redeclared, so `routes/auth.ts`'s `err instanceof RefreshError`
// means the same thing whichever store threw — before, during and after the
// cutover. `auth/refresh-contract.ts` holds them and touches no database.
export {
  RefreshError,
  REFRESH_GRACE_MS,
  type IssuedRefresh,
  type IssueRefreshTokenOptions,
} from '../../../auth/refresh-contract.ts';

/** The columns a rotation or a classification needs off an existing row. */
interface TokenRow {
  id: string;
  user_id: string;
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
  device_label: string;
  family_id: string | null;
  family_revoked_at: string | null;
  platform: string | null;
  secure: number | null;
}

const TOKEN_COLUMNS = `id, user_id, issued_at, expires_at, revoked_at, device_label,
                       family_id, family_revoked_at, platform, secure`;

async function readByHash(db: SqliteDb, tokenHash: string): Promise<TokenRow | null> {
  const rows = await db.read<TokenRow>(
    `SELECT ${TOKEN_COLUMNS} FROM refresh_tokens WHERE token_hash = ?`,
    [tokenHash],
  );
  return rows[0] ?? null;
}

/** Issue a refresh token. See {@link IssueRefreshTokenOptions}. */
export async function issueRefreshToken(
  userId: ObjectId,
  deviceLabel: string,
  opts: IssueRefreshTokenOptions = {},
  dbOverride?: SqliteDb,
): Promise<IssuedRefresh> {
  const { familyId, platform, secure = true } = opts;
  const raw = generateRefreshToken();
  const family = familyId === undefined ? newObjectIdHex() : toHex(familyId);
  await sqliteDb(dbOverride).write(
    `INSERT INTO refresh_tokens
       (id, user_id, token_hash, issued_at, expires_at, device_label, family_id, platform, secure)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newObjectIdHex(),
      toHex(userId),
      hashRefreshToken(raw),
      nowIso(),
      refreshExpiresAt().toISOString(),
      deviceLabel,
      family,
      platform ?? null,
      secure ? 1 : 0,
    ],
  );
  return { raw, userId, familyId: toObjectId(family), secure };
}

/**
 * The two statements that make up a successful rotation. See the module
 * comment for why the insert comes first.
 */
function rotationBatch(args: {
  successorId: string;
  successorHash: string;
  freshFamilyId: string;
  oldHash: string;
  nowIso: string;
  expiresAt: string;
}) {
  const live = `token_hash = ? AND revoked_at IS NULL AND expires_at > ?`;
  return [
    {
      sql: `INSERT INTO refresh_tokens
              (id, user_id, token_hash, issued_at, expires_at, device_label,
               family_id, platform, secure)
            SELECT ?, user_id, ?, ?, ?, device_label, COALESCE(family_id, ?), platform,
                   COALESCE(secure, 1)
              FROM refresh_tokens
             WHERE ${live}`,
      params: [
        args.successorId,
        args.successorHash,
        args.nowIso,
        args.expiresAt,
        args.freshFamilyId,
        args.oldHash,
        args.nowIso,
      ],
    },
    {
      sql: `UPDATE refresh_tokens SET revoked_at = ?, replaced_by = ? WHERE ${live}`,
      params: [args.nowIso, args.successorId, args.oldHash, args.nowIso],
    },
  ];
}

/** `true` when a member of this family is still live. */
async function familyHasLiveToken(db: SqliteDb, familyId: string): Promise<boolean> {
  const rows = await db.read<{ id: string }>(
    `SELECT id FROM refresh_tokens WHERE family_id = ? AND revoked_at IS NULL LIMIT 1`,
    [familyId],
  );
  return rows.length > 0;
}

/**
 * The successor the winning transaction just committed, as the caller's
 * result. Its lineage was copied from the parent in SQL, so this reads it back
 * rather than recomputing it.
 */
async function issuedSuccessor(
  db: SqliteDb,
  successorId: string,
  successorRaw: string,
): Promise<IssuedRefresh> {
  const rows = await db.read<{ user_id: string; family_id: string; secure: number | null }>(
    `SELECT user_id, family_id, secure FROM refresh_tokens WHERE id = ?`,
    [successorId],
  );
  const row = rows[0];
  if (row === undefined) {
    // Only reachable if the committed insert vanished, which nothing in this
    // process can do. Surfacing it as a conflict lets the client retry.
    throw new RefreshError('rotation_conflict', 'refresh token rotation conflict');
  }
  return {
    raw: successorRaw,
    userId: toObjectId(row.user_id),
    familyId: toObjectId(row.family_id),
    secure: row.secure === null ? true : toBool(row.secure),
  };
}

/**
 * What a token that failed the liveness swap actually is, and what to do about
 * it. Always either re-mints or throws; it never returns "nothing happened".
 *
 *  - Unknown, or live-but-expired → say which.
 *  - Revoked moments ago while the family still holds a live token → a lost
 *    response or two tabs refreshing at once. Re-mint in the same family.
 *  - Revoked moments ago with no live sibling → a racing rotation whose
 *    successor has not committed. Reject WITHOUT revoking, so the winner
 *    survives and the client's retry self-heals.
 *  - Revoked long enough ago to be genuine reuse → revoke the whole family.
 */
async function recoverOrReject(db: SqliteDb, oldHash: string, now: Date): Promise<IssuedRefresh> {
  const row = await readByHash(db, oldHash);
  if (!row) throw new RefreshError('unknown_token', 'unknown refresh token');
  if (row.revoked_at === null) throw new RefreshError('token_expired', 'refresh token expired');

  const withinGrace = now.getTime() - new Date(row.revoked_at).getTime() <= REFRESH_GRACE_MS;
  if (!withinGrace) return await revokeAfterReuse(db, row);

  if (row.family_revoked_at !== null) {
    throw new RefreshError('reuse_detected', 'refresh token family revoked');
  }
  if (row.family_id === null || !(await familyHasLiveToken(db, row.family_id))) {
    throw new RefreshError('rotation_conflict', 'refresh token rotation conflict');
  }
  return await remintInFamily(db, row, row.family_id);
}

/**
 * Treat a long-dead token as theft: revoke the device's whole lineage and say
 * so. A legacy token issued before family tracking has no family to kill, so
 * the fallback is every family the user holds.
 */
async function revokeAfterReuse(db: SqliteDb, row: TokenRow): Promise<never> {
  if (row.family_id === null) await revokeChain(toObjectId(row.user_id), db);
  else await revokeFamily(toObjectId(row.family_id), db);
  throw new RefreshError('reuse_detected', 'refresh token reuse detected — family revoked');
}

/**
 * Re-mint into an existing lineage, carrying the rotated token's platform
 * marker and cookie-security flag forward so the family stays labelled.
 */
async function remintInFamily(
  db: SqliteDb,
  row: TokenRow,
  familyId: string,
): Promise<IssuedRefresh> {
  return await issueRefreshToken(
    toObjectId(row.user_id),
    row.device_label,
    {
      familyId: toObjectId(familyId),
      ...(row.platform === null ? {} : { platform: row.platform }),
      secure: row.secure === null ? true : toBool(row.secure),
    },
    db,
  );
}

/**
 * Rotate a refresh token: consume it and hand back its successor.
 *
 * The happy path is the transaction — it either wins the liveness swap or it
 * does not, and the second statement's row count says which. Everything else
 * is {@link recoverOrReject}, which decides whether a token that failed the
 * swap is a benign retry or theft.
 */
export async function rotateRefreshToken(
  rawOld: string,
  dbOverride?: SqliteDb,
): Promise<IssuedRefresh> {
  const db = sqliteDb(dbOverride);
  const oldHash = hashRefreshToken(rawOld);
  const now = new Date();
  const successorId = newObjectIdHex();
  const successorRaw = generateRefreshToken();

  const results = await db.transaction(
    rotationBatch({
      successorId,
      successorHash: hashRefreshToken(successorRaw),
      freshFamilyId: newObjectIdHex(),
      oldHash,
      nowIso: now.toISOString(),
      expiresAt: refreshExpiresAt().toISOString(),
    }),
  );

  return changesAt(results, 1) === 1
    ? await issuedSuccessor(db, successorId, successorRaw)
    : await recoverOrReject(db, oldHash, now);
}

/**
 * Revoke every live token in a family (one device's rotation lineage).
 *
 * `COALESCE` keeps an already-revoked token's original `revoked_at`, which is
 * what the grace window in {@link rotateRefreshToken} measures against.
 */
export async function revokeFamily(familyId: ObjectId, dbOverride?: SqliteDb): Promise<void> {
  const revokedAt = nowIso();
  await sqliteDb(dbOverride).write(
    `UPDATE refresh_tokens
        SET family_revoked_at = ?, revoked_at = COALESCE(revoked_at, ?)
      WHERE family_id = ?`,
    [revokedAt, revokedAt, toHex(familyId)],
  );
}

/**
 * Revoke the whole family a raw token belongs to — what logout uses, so the
 * device's entire lineage signs out rather than only the presented token.
 */
export async function revokeFamilyByToken(rawToken: string, dbOverride?: SqliteDb): Promise<void> {
  const db = sqliteDb(dbOverride);
  const row = await readByHash(db, hashRefreshToken(rawToken));
  if (!row) return;
  if (row.family_id !== null) {
    await revokeFamily(toObjectId(row.family_id), db);
    return;
  }
  const revokedAt = nowIso();
  await db.write(`UPDATE refresh_tokens SET revoked_at = ?, family_revoked_at = ? WHERE id = ?`, [
    revokedAt,
    revokedAt,
    row.id,
  ]);
}

/**
 * Revoke every live refresh family for a user — a deliberate "log out
 * everywhere".
 *
 * Access tokens are stateless, so one already issued stays valid until its
 * 15-minute TTL expires; after that the revoked refresh cannot renew it.
 */
export async function revokeChain(userId: ObjectId, dbOverride?: SqliteDb): Promise<void> {
  const revokedAt = nowIso();
  await sqliteDb(dbOverride).write(
    `UPDATE refresh_tokens
        SET family_revoked_at = ?, revoked_at = COALESCE(revoked_at, ?)
      WHERE user_id = ?`,
    [revokedAt, revokedAt, toHex(userId)],
  );
}
