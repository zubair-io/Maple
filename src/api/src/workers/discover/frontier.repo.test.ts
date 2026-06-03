import { describe, it, expect, beforeAll, beforeEach } from 'bun:test';
import { ObjectId } from 'mongodb';
import { getDb } from '../../db/client.ts';

let reachable = true;
beforeAll(async () => {
  try {
    await getDb();
  } catch {
    reachable = false;
  }
});
beforeEach(async () => {
  if (!reachable) return;
  await (await getDb()).collection('discover_frontier').deleteMany({});
});

describe('frontier.repo', () => {
  it('seeds a root, claims it exactly once, then completes it', async () => {
    if (!reachable) return;
    const repo = await import('./frontier.repo.ts');
    const folder = new ObjectId();
    await repo.seedRoot(folder, '/srv/photos/Library', 1);

    const a = await repo.claimNextDir(folder, 1, 60_000);
    const b = await repo.claimNextDir(folder, 1, 60_000);
    expect(a?.dir_path).toBe('/srv/photos/Library');
    expect(b).toBeNull(); // already claimed (lease held)

    await repo.enqueueDirs(folder, ['/srv/photos/Library/2024'], 1);
    expect(await repo.remainingForGen(folder, 1)).toBe(2); // root (claimed) + child

    await repo.completeDir(a!._id);
    expect(await repo.remainingForGen(folder, 1)).toBe(1);
  });

  it('re-claims a dir whose lease expired', async () => {
    if (!reachable) return;
    const repo = await import('./frontier.repo.ts');
    const folder = new ObjectId();
    await repo.seedRoot(folder, '/x', 1);
    await repo.claimNextDir(folder, 1, -1); // already-expired lease
    const again = await repo.claimNextDir(folder, 1, 60_000);
    expect(again?.dir_path).toBe('/x');
  });
});
