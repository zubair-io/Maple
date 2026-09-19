/**
 * The frontier's behaviour is covered in depth by
 * `db/repos/discover-frontier.repo.test.ts`, which drives the repository
 * functions directly. What is left to check here is that this module still
 * hands the sweeper the same five verbs, resolving against the process-wide
 * handle the way production reaches them — a re-export that named a function
 * the repository no longer has would fail to compile, but one that pointed at a
 * different database would not.
 */
import { describe, it, expect } from 'bun:test';
import { createLiveTestDatabase, insertFolder } from '../../db/sqlite/test-sqlite.test-helpers.ts';
import { toObjectId } from '../../db/repos/values.ts';
import * as frontier from './frontier.repo.ts';

describe('frontier.repo', () => {
  it('seeds a root, claims it exactly once, then completes it', async () => {
    using live = await createLiveTestDatabase();
    const folder = toObjectId(insertFolder(live.db));
    await frontier.seedRoot(folder, '/srv/photos/Library', 1);

    const a = await frontier.claimNextDir(folder, 1, 60_000);
    const b = await frontier.claimNextDir(folder, 1, 60_000);
    expect(a?.dir_path).toBe('/srv/photos/Library');
    expect(b).toBeNull(); // already claimed (lease held)

    await frontier.enqueueDirs(folder, ['/srv/photos/Library/2024'], 1, false);
    expect(await frontier.remainingForGen(folder, 1)).toBe(2); // root (claimed) + child

    await frontier.completeDir(a!._id);
    expect(await frontier.remainingForGen(folder, 1)).toBe(1);
  });

  it('re-claims a dir whose lease expired', async () => {
    using live = await createLiveTestDatabase();
    const folder = toObjectId(insertFolder(live.db));
    await frontier.seedRoot(folder, '/x', 1);
    await frontier.claimNextDir(folder, 1, -1); // already-expired lease
    const again = await frontier.claimNextDir(folder, 1, 60_000);
    expect(again?.dir_path).toBe('/x');
  });
});
