/**
 * `auth/jwt-secret.repo.ts` reaches the SQLite store (#3787).
 *
 * The get-or-create's own guarantees — racing boots converging, a half-written
 * row being filled, an existing secret never being overwritten — are covered
 * against the repository in `db/sqlite/repos/server-state.repo.test.ts`. This
 * file covers what `auth/jwt-bootstrap.ts` depends on: that the function it
 * calls at startup resolves, persists under the documented id, and reports
 * `created` only for the boot that actually minted the secret.
 */

import { describe, expect, it } from 'bun:test';
import { getOrCreateJwtSecret, JWT_SECRET_DOC_ID } from './jwt-secret.repo.ts';
import { createLiveTestDatabase } from '../db/sqlite/test-sqlite.test-helpers.ts';

describe('jwt-secret.repo through the auth module', () => {
  it('mints the secret on first boot and hands back the same one afterwards', async () => {
    using live = await createLiveTestDatabase();

    const first = await getOrCreateJwtSecret();
    expect(first.created).toBe(true);
    expect(first.secret.length).toBeGreaterThanOrEqual(32);

    const second = await getOrCreateJwtSecret();
    // A restart that minted a second secret would turn every issued token into
    // a `bad signature` 401, which is the whole reason this lives in the
    // database rather than in a file.
    expect(second).toEqual({ secret: first.secret, created: false });

    const rows = live.db
      .query(`SELECT value FROM server_state WHERE id = ?`)
      .all(JWT_SECRET_DOC_ID) as Array<{ value: string | null }>;
    expect(rows).toEqual([{ value: first.secret }]);
  });
});
