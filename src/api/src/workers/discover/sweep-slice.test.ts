/**
 * A sweep slice: the per-directory sweep, bounded so a Temporal activity can
 * run it. A slice keeps sweeping across generations, so the cases that do not
 * test a particular way of ending stop it after a set number of generations.
 * Every way a slice ends is covered here against a real database and a
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

/** Stopped once `generations` walks have completed, unless the case passes its own signal. */
function sliceOf(
  library: DiscoverLibrary,
  overrides: Partial<SweepSliceOpts> = {},
  generations = 1,
) {
  const stop = new AbortController();
  const heartbeat = overrides.heartbeat ?? (() => {});
  return runSweepSlice({
    folderId: library.folderId,
    root: library.root,
    deps: { folderId: library.folderId, handleEvent: async () => {} },
    loadConfig: unpaced,
    sleep: async () => {},
    signal: stop.signal,
    ...overrides,
    heartbeat: (progress) => {
      heartbeat(progress);
      if (progress.generationsCompleted >= generations) stop.abort();
    },
  });
}

function withDirs(library: DiscoverLibrary, names: readonly string[]): void {
  for (const name of names) mkdirSync(join(library.root, name));
}

describe('runSweepSlice', () => {
  it('keeps sweeping across a generation advance', async () => {
    using library = await createDiscoverLibrary('maple-slice-gen-');
    withDirs(library, ['a', 'b']);
    const visited: string[] = [];
    const tree = [library.root, join(library.root, 'a'), join(library.root, 'b')];

    const summary = await sliceOf(library, { onVisit: (dir) => visited.push(dir) }, 2);

    expect(summary).toEqual({
      generation: 3,
      generationsCompleted: 2,
      directoriesVisited: 6,
      registered: true,
    });
    expect(visited.toSorted()).toEqual([...tree, ...tree].toSorted());
    expect(await frontier.remainingForGen(library.folderId, 3)).toBe(1);
  });

  it('consecutive slices walk consecutive generations', async () => {
    using library = await createDiscoverLibrary('maple-slice-next-');

    await sliceOf(library);
    const second = await sliceOf(library);

    expect(second).toEqual({
      generation: 3,
      generationsCompleted: 1,
      directoriesVisited: 1,
      registered: true,
    });
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

    expect(summary).toEqual({
      generation: 1,
      generationsCompleted: 0,
      directoriesVisited: 0,
      registered: true,
    });
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

    expect(summary).toEqual({
      generation: 1,
      generationsCompleted: 0,
      directoriesVisited: 1,
      registered: true,
    });
    expect(await frontier.remainingForGen(library.folderId, 1)).toBe(2);
  });

  it('a stop between file events abandons the visit and leaves its directory to be redone', async () => {
    using library = await createDiscoverLibrary('maple-slice-mid-visit-');
    for (const name of ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg']) {
      writeFileSync(join(library.root, name), name);
    }
    const stop = new AbortController();
    let handled = 0;

    const summary = await sliceOf(library, {
      signal: stop.signal,
      deps: {
        folderId: library.folderId,
        handleEvent: async () => {
          handled += 1;
          stop.abort();
        },
      },
    });

    expect(handled).toBe(1);
    expect(summary).toEqual({
      generation: 1,
      generationsCompleted: 0,
      directoriesVisited: 0,
      registered: true,
    });
    expect(await frontier.remainingForGen(library.folderId, 1)).toBe(1);
    expect(await frontier.claimNextDir(library.folderId, 1, 60_000)).toBeNull();
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

    expect(summary).toEqual({
      generation: 1,
      generationsCompleted: 0,
      directoriesVisited: 0,
      registered: true,
    });
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

    expect(summary).toEqual({
      generation: 1,
      generationsCompleted: 0,
      directoriesVisited: 0,
      registered: false,
    });
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

    expect(summary).toEqual({
      generation: 1,
      generationsCompleted: 0,
      directoriesVisited: 1,
      registered: false,
    });
  });
});
