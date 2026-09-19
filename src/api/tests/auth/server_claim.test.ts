/**
 * `auth/server_claim.ts` reaches the SQLite store (#3787).
 *
 * The sentinel's own behaviour — the concurrent race, the release, the
 * boot-time backfill — is covered against the repository in
 * `db/repos/server-state.repo.test.ts`. This file covers the module
 * `routes/auth.ts` and `index.ts` import: that the claim they call is the
 * SQLite one, and that the exported id still names the row they look for.
 */

import { describe, it, expect } from 'bun:test';
import {
  OWNER_CLAIM_ID,
  releaseOwnershipClaim,
  tryClaimOwnership,
} from '../../src/auth/server_claim.ts';
import { createLiveTestDatabase } from '../../src/db/sqlite/test-sqlite.test-helpers.ts';

describe('server ownership claim (#865) through the auth module', () => {
  it('the first registration wins the single owner slot, and only the first', async () => {
    using live = await createLiveTestDatabase();

    expect(await tryClaimOwnership()).toBe(true);
    expect(await tryClaimOwnership()).toBe(false);

    const rows = live.db
      .query(`SELECT id FROM server_state WHERE id = ?`)
      .all(OWNER_CLAIM_ID) as Array<{ id: string }>;
    expect(rows).toHaveLength(1);
  });

  it('releasing lets the server be claimed again after a failed registration', async () => {
    using live = await createLiveTestDatabase();

    expect(await tryClaimOwnership()).toBe(true);
    await releaseOwnershipClaim();
    expect(await tryClaimOwnership()).toBe(true);
  });
});
