/**
 * A sweep slice: the per-directory sweep, bounded so a Temporal activity can
 * run it. Every way a slice ends is covered here against a real database and a
 * real directory tree; the workflow around it is covered by
 * `temporal/discover-lane.integration.test.ts`.
 */
import { describe, expect, it } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeCheckpoint } from '../../db/repos/indexer-checkpoints.repo.ts';
import { createDiscoverLibrary, type DiscoverLibrary } from './discover.test-helpers.ts';
import * as frontier from './frontier.repo.ts';
import { runSweepSlice, type SliceProgress, type SweepSliceOpts } from './sweep-slice.ts';

const unpaced = async () => ({ paused: false, sweepDirIntervalMs: 0 });

function sliceOf(library: DiscoverLibrary, overrides: Partial<SweepSliceOpts> = {}) {
  return runSweepSlice({
    folderId: library.folderId,
    root: library.root,
    deps: { folderId: library.folderId, handleEvent: async () => {} },
    loadConfig: unpaced,
    heartbeat: () => {},
    sleep: async () => {},
    ...overrides,
  });
}

function withDirs(library: DiscoverLibrary, names: readonly string[]): void {
  for (const name of names) mkdirSync(join(library.root, name));
}

describe('runSweepSlice', () => {
  it('walks one whole generation, seeds the next, and stops there', async () => {
    using library = await createDiscoverLibrary('maple-slice-gen-');
    withDirs(library, ['a', 'b']);
    const visited: string[] = [];

    const summary = await sliceOf(library, { onVisit: (dir) => visited.push(dir) });

    expect(summary).toEqual({ generation: 2, directoriesVisited: 3, registered: true });
    expect(visited.toSorted()).toEqual(
      [library.root, join(library.root, 'a'), join(library.root, 'b')].toSorted(),
    );
    expect(await frontier.remainingForGen(library.folderId, 2)).toBe(1);
  });

  it('consecutive slices walk consecutive generations', async () => {
    using library = await createDiscoverLibrary('maple-slice-next-');

    await sliceOf(library);
    const second = await sliceOf(library);

    expect(second).toEqual({ generation: 3, directoriesVisited: 1, registered: true });
  });

  it('resumes the generation its checkpoint records, without re-walking generation one', async () => {
    using library = await createDiscoverLibrary('maple-slice-resume-');
    await writeCheckpoint({
      folderId: library.folderId.toHexString(),
      path: library.root,
      lastWalkedAt: Date.now(),
      inflightIds: [],
      sweepGen: 3,
      updatedAt: Date.now(),
    });
    await frontier.enqueueDirs(library.folderId, [library.root], 3, false);
    const visited: string[] = [];

    const summary = await sliceOf(library, { onVisit: (dir) => visited.push(dir) });

    expect(visited).toEqual([library.root]);
    expect(summary.generation).toBe(4);
    expect(await frontier.remainingForGen(library.folderId, 1)).toBe(0);
  });

  it('stops on its time bound before the generation drains', async () => {
    using library = await createDiscoverLibrary('maple-slice-time-');
    withDirs(library, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']);

    const summary = await runSweepSlice({
      folderId: library.folderId,
      root: library.root,
      deps: { folderId: library.folderId, handleEvent: async () => {} },
      loadConfig: async () => ({ paused: false, sweepDirIntervalMs: 20 }),
      heartbeat: () => {},
      maxSliceMs: 50,
    });

    expect(summary.generation).toBe(1);
    expect(summary.directoriesVisited).toBeGreaterThan(0);
    expect(summary.directoriesVisited).toBeLessThan(11);
    expect(await frontier.remainingForGen(library.folderId, 1)).toBe(
      11 - summary.directoriesVisited,
    );
  });

  it('a slice with no time left visits nothing', async () => {
    using library = await createDiscoverLibrary('maple-slice-none-');

    const summary = await sliceOf(library, { maxSliceMs: 0 });

    expect(summary).toEqual({ generation: 1, directoriesVisited: 0, registered: true });
    expect(await frontier.remainingForGen(library.folderId, 1)).toBe(1);
  });

  it('an abort finishes the directory in hand and stops before the next', async () => {
    using library = await createDiscoverLibrary('maple-slice-abort-');
    withDirs(library, ['a', 'b']);
    const stop = new AbortController();

    const summary = await sliceOf(library, {
      signal: stop.signal,
      onVisit: () => stop.abort(),
    });

    expect(summary).toEqual({ generation: 1, directoriesVisited: 1, registered: true });
    expect(await frontier.remainingForGen(library.folderId, 1)).toBe(2);
  });

  it('heartbeats after every directory', async () => {
    using library = await createDiscoverLibrary('maple-slice-beat-');
    withDirs(library, ['a', 'b']);
    const beats: SliceProgress[] = [];

    await sliceOf(library, { heartbeat: (progress) => beats.push(progress) });

    const visits = beats.map((beat) => beat.directoriesVisited);
    expect(visits).toContain(1);
    expect(visits).toContain(2);
    expect(visits).toContain(3);
    expect(beats.every((beat) => beat.root === library.root)).toBe(true);
  });

  it('heartbeats after every file event inside a directory, too', async () => {
    using library = await createDiscoverLibrary('maple-slice-event-beat-');
    for (const name of ['a.jpg', 'b.jpg', 'c.jpg']) writeFileSync(join(library.root, name), name);
    const order: string[] = [];

    await sliceOf(library, {
      deps: {
        folderId: library.folderId,
        handleEvent: async (event) => {
          order.push(`event:${event.absPath.split('/').pop()}`);
        },
      },
      heartbeat: () => order.push('beat'),
    });

    const events = order.filter((entry) => entry.startsWith('event:'));
    expect(events).toHaveLength(3);
    for (const event of events) expect(order[order.indexOf(event) + 1]).toBe('beat');
  });

  it('while paused it visits nothing, but heartbeats at least every interval', async () => {
    using library = await createDiscoverLibrary('maple-slice-paused-');
    const stop = new AbortController();
    const naps: number[] = [];
    let beats = 0;

    const summary = await sliceOf(library, {
      loadConfig: async () => ({ paused: true, sweepDirIntervalMs: 25 }),
      heartbeatEveryMs: 10,
      signal: stop.signal,
      sleep: async (ms) => {
        naps.push(ms);
      },
      heartbeat: () => {
        beats += 1;
        if (beats === 250) stop.abort();
      },
    });

    expect(summary).toEqual({ generation: 1, directoriesVisited: 0, registered: true });
    expect(Math.max(...naps)).toBe(10);
    expect(beats).toBe(naps.length);
    expect(await frontier.remainingForGen(library.folderId, 1)).toBe(1);
  });

  it('a root that was never registered ends at once as gone', async () => {
    using library = await createDiscoverLibrary('maple-slice-unknown-');
    const visited: string[] = [];

    const summary = await sliceOf(library, {
      root: join(library.root, 'elsewhere'),
      onVisit: (dir) => visited.push(dir),
    });

    expect(summary).toEqual({ generation: 1, directoriesVisited: 0, registered: false });
    expect(visited).toEqual([]);
  });

  it('a root removed mid-slice ends the slice as gone', async () => {
    using library = await createDiscoverLibrary('maple-slice-removed-');
    withDirs(library, ['a', 'b']);

    let visits = 0;

    const summary = await sliceOf(library, {
      onVisit: () => {
        visits += 1;
      },
      isRegistered: async () => visits === 0,
    });

    expect(summary).toEqual({ generation: 1, directoriesVisited: 1, registered: false });
  });
});
