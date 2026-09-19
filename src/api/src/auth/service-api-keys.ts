/**
 * Service API keys: the key format, and four operations on the keys table.
 *
 * The storage moved to `db/sqlite/repos/auth.service-api-keys.repo.ts` at the
 * cutover (#3787); the format did not. Minting a key, hashing its secret and
 * comparing that hash in constant time are this module's job and stay here —
 * a second copy of a timing-safe comparison inside a database module would be
 * one copy too many. What crosses the boundary is four calls: insert, look up
 * by public key id, list, and stamp last-used.
 *
 * `revokeServiceApiKey` is storage all the way down, id guard included, so it
 * is re-exported from the repository rather than reimplemented.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ObjectId } from 'mongodb';
import {
  findServiceApiKeyByKeyId,
  insertServiceApiKey,
  listServiceApiKeyRows,
  markServiceApiKeyUsed,
} from '../db/sqlite/repos/auth.service-api-keys.repo.ts';
import type { ServiceApiKeyDoc, ServiceApiScope } from '../db/schema.ts';

export { revokeServiceApiKey } from '../db/sqlite/repos/auth.service-api-keys.repo.ts';

const KEY_PREFIX = 'maple_sk';
const KEY_ID_BYTES = 8;
const SECRET_BYTES = 32;
const KEY_PATTERN = /^maple_sk_([a-f0-9]{16})_([A-Za-z0-9_-]{43})$/;
const DUMMY_HASH = '0'.repeat(64);

const SERVICE_API_SCOPES = ['assets:search'] as const satisfies readonly ServiceApiScope[];

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function constantTimeHexEqual(left: string, right: string): boolean {
  const a = Buffer.from(left.padEnd(64, '0').slice(0, 64), 'hex');
  const b = Buffer.from(right.padEnd(64, '0').slice(0, 64), 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface CreatedServiceApiKey {
  key: string;
  keyId: string;
  prefix: string;
  name: string;
  scopes: ServiceApiScope[];
  createdAt: string;
  expiresAt: string | null;
}

export async function createServiceApiKey(input: {
  name: string;
  scopes?: ServiceApiScope[];
  createdBy: ObjectId;
  expiresAt?: Date | null;
}): Promise<CreatedServiceApiKey> {
  const name = input.name.trim();
  if (name.length === 0) throw new Error('name must not be empty');
  const scopes: ServiceApiScope[] = input.scopes?.length
    ? [...new Set<ServiceApiScope>(input.scopes)]
    : ['assets:search'];
  for (const scope of scopes) {
    if (!SERVICE_API_SCOPES.includes(scope)) throw new Error(`unsupported scope: ${scope}`);
  }

  const keyId = randomBytes(KEY_ID_BYTES).toString('hex');
  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  const key = `${KEY_PREFIX}_${keyId}_${secret}`;
  const now = new Date().toISOString();
  const doc: ServiceApiKeyDoc = {
    key_id: keyId,
    name,
    secret_hash: sha256(secret),
    scopes,
    created_at: now,
    created_by: input.createdBy,
    expires_at: input.expiresAt ?? null,
    revoked_at: null,
    last_used_at: null,
  };
  await insertServiceApiKey(doc);
  return {
    key,
    keyId,
    prefix: `${KEY_PREFIX}_${keyId}`,
    name,
    scopes,
    createdAt: now,
    expiresAt: doc.expires_at?.toISOString() ?? null,
  };
}

export interface ServiceApiIdentity {
  keyId: string;
  prefix: string;
  name: string;
  scopes: ServiceApiScope[];
}

export type ServiceApiAuthResult =
  | { ok: true; identity: ServiceApiIdentity }
  | {
      ok: false;
      status: 401 | 403;
      reason:
        | 'missing_bearer'
        | 'invalid_key'
        | 'expired_key'
        | 'revoked_key'
        | 'insufficient_scope';
    };

export async function authenticateServiceApiKey(
  authorization: string | null,
  requiredScope: ServiceApiScope,
): Promise<ServiceApiAuthResult> {
  const bearer = /^Bearer (.+)$/.exec(authorization ?? '');
  if (!bearer) return { ok: false, status: 401, reason: 'missing_bearer' };
  const parsed = KEY_PATTERN.exec(bearer[1]!);
  if (!parsed) return { ok: false, status: 401, reason: 'invalid_key' };
  const [, keyId, secret] = parsed;

  const doc = await findServiceApiKeyByKeyId(keyId!);
  const actualHash = sha256(secret!);
  const hashMatches = constantTimeHexEqual(actualHash, doc?.secret_hash ?? DUMMY_HASH);
  if (!doc || !hashMatches) return { ok: false, status: 401, reason: 'invalid_key' };
  if (doc.revoked_at !== null) return { ok: false, status: 401, reason: 'revoked_key' };
  if (doc.expires_at !== null && doc.expires_at.getTime() <= Date.now()) {
    return { ok: false, status: 401, reason: 'expired_key' };
  }
  if (!doc.scopes.includes(requiredScope)) {
    return { ok: false, status: 403, reason: 'insufficient_scope' };
  }

  // Fire-and-forget: a request is not worth failing because its usage stamp
  // could not be written. The repository's own `revoked_at IS NULL` guard is
  // what stops a request authorised a moment before a revocation from marking
  // the revoked key active again.
  const lastUsedAt = new Date().toISOString();
  void markServiceApiKeyUsed(doc._id, lastUsedAt).catch(() => {});
  return {
    ok: true,
    identity: {
      keyId: doc.key_id,
      prefix: `${KEY_PREFIX}_${doc.key_id}`,
      name: doc.name,
      scopes: doc.scopes,
    },
  };
}

export async function listServiceApiKeys(): Promise<
  Array<{
    keyId: string;
    prefix: string;
    name: string;
    scopes: ServiceApiScope[];
    createdAt: string;
    expiresAt: string | null;
    revokedAt: string | null;
    lastUsedAt: string | null;
  }>
> {
  const rows = await listServiceApiKeyRows();
  return rows.map((row) => ({
    keyId: row.key_id,
    prefix: `${KEY_PREFIX}_${row.key_id}`,
    name: row.name,
    scopes: row.scopes,
    createdAt: row.created_at,
    expiresAt: row.expires_at?.toISOString() ?? null,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
  }));
}
