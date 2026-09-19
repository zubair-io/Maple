/**
 * Service API keys: the format, and what authentication makes of it.
 *
 * The four storage operations are tested against the table in
 * `db/sqlite/repos/auth.enrolment.repo.test.ts`. What is left here — and what
 * these cases are about — is the half that never moved: a key is minted in one
 * piece and handed over once, only its hash is kept, and authentication
 * distinguishes an unknown key from a revoked one from an expired one from a
 * key whose scopes fall short.
 *
 * These functions take no database handle, because their callers are routes
 * that have none either. So the database is installed as the process-wide
 * handle for the block rather than passed in.
 */

import { describe, expect, test } from 'bun:test';
import type { ObjectId } from 'mongodb';
import {
  authenticateServiceApiKey,
  createServiceApiKey,
  listServiceApiKeys,
  revokeServiceApiKey,
} from './service-api-keys.ts';
import { insertUser } from '../db/sqlite/repos/auth.users.repo.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';

/** Mirrors `KEY_PATTERN` in service-api-keys.ts (module-private there). */
const KEY_SHAPE = /^maple_sk_[a-f0-9]{16}_([A-Za-z0-9_-]{43})$/;

/**
 * The plaintext secret — the third field of `maple_sk_<key id>_<secret>`.
 *
 * Deliberately a shape match, not `split('_')`: the secret is base64url and
 * that alphabet contains `_`, so splitting yields a tail fragment rather than
 * the secret whenever one lands near the end.
 */
function secretOf(key: string): string {
  const match = KEY_SHAPE.exec(key);
  // Report the shape, never the value: this helper exists for a secret-leak
  // assertion, so echoing the key into a CI log on failure would be the very
  // thing it guards against. Length plus prefix is enough to debug a shape
  // change, and neither reveals the secret.
  if (!match) {
    throw new Error(
      `key does not match the expected shape (length ${key.length}, prefix ${key.slice(0, 9)})`,
    );
  }
  return match[1]!;
}

/** An owner to hang the keys off — `created_by` is a foreign key. */
async function seedOwner(live: LiveTestDatabase): Promise<ObjectId> {
  return await insertUser(
    {
      email: 'owner@maple.test',
      role: 'owner',
      created_at: new Date().toISOString(),
      last_seen_at: null,
    },
    live.handle,
  );
}

/** One stored key, straight off the table. */
function storedRow(live: LiveTestDatabase, keyId: string): Record<string, unknown> {
  return live.db.query(`SELECT * FROM service_api_keys WHERE key_id = ?`).get(keyId) as Record<
    string,
    unknown
  >;
}

describe('service API keys', () => {
  test('stores only a secret hash and returns plaintext once', async () => {
    using live = await createLiveTestDatabase();
    const createdBy = await seedOwner(live);
    const created = await createServiceApiKey({ name: 'SugarMaple', createdBy });
    expect(created.key).toMatch(KEY_SHAPE);

    const stored = storedRow(live, created.keyId);
    expect(stored.secret_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(created.key);
    // Capture the secret by the key's shape rather than `split('_')`. base64url's
    // alphabet includes `_`, so splitting on it returns whatever follows the LAST
    // underscore — a one- or two-character tail whenever the secret happens to
    // contain one near its end. A fragment that short matches something in every
    // stored row (an id, the 64-char hash, the timestamp), so the old form passed
    // by accident and failed a few percent of the time (#2367).
    expect(JSON.stringify(stored)).not.toContain(secretOf(created.key));

    const listed = await listServiceApiKeys();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      keyId: created.keyId,
      name: 'SugarMaple',
      scopes: ['assets:search'],
    });
    expect(JSON.stringify(listed)).not.toContain('secret_hash');
  });

  test('authenticates scope, then rejects revoked and expired keys', async () => {
    using live = await createLiveTestDatabase();
    const createdBy = await seedOwner(live);
    const created = await createServiceApiKey({ name: 'Search consumer', createdBy });
    const valid = await authenticateServiceApiKey(`Bearer ${created.key}`, 'assets:search');
    expect(valid.ok).toBe(true);

    expect(await revokeServiceApiKey(created.keyId)).toBe(true);
    const revoked = await authenticateServiceApiKey(`Bearer ${created.key}`, 'assets:search');
    expect(revoked).toMatchObject({ ok: false, status: 401, reason: 'revoked_key' });

    const expired = await createServiceApiKey({
      name: 'Expired',
      createdBy,
      expiresAt: new Date(Date.now() + 60_000),
    });
    live.db.run(`UPDATE service_api_keys SET expires_at = ? WHERE key_id = ?`, [
      new Date(0).toISOString(),
      expired.keyId,
    ]);
    const expiredResult = await authenticateServiceApiKey(`Bearer ${expired.key}`, 'assets:search');
    expect(expiredResult).toMatchObject({ ok: false, status: 401, reason: 'expired_key' });
  });

  test('a key that names nothing is refused the same way as a wrong secret', async () => {
    using live = await createLiveTestDatabase();
    const createdBy = await seedOwner(live);
    const created = await createServiceApiKey({ name: 'Search consumer', createdBy });
    const tampered = `${created.key.slice(0, -1)}${created.key.endsWith('A') ? 'B' : 'A'}`;

    // An unknown key id and a real key id with the wrong secret are one answer
    // on purpose — both go through the constant-time comparison first.
    expect(
      await authenticateServiceApiKey(
        `Bearer maple_sk_${'0'.repeat(16)}_${'a'.repeat(43)}`,
        'assets:search',
      ),
    ).toMatchObject({ ok: false, status: 401, reason: 'invalid_key' });
    expect(await authenticateServiceApiKey(`Bearer ${tampered}`, 'assets:search')).toMatchObject({
      ok: false,
      status: 401,
      reason: 'invalid_key',
    });
  });
});
