/**
 * The daily schedule against real SQLite with an injected clock (#4602).
 *
 * A "restart" here is simply another tick: the schedule keeps no memory
 * between ticks, so a fresh process and the next tick of a running one ask the
 * same persisted question. The per-library LLM pass is replaced by a stub that
 * returns placeholder collections, so these tests pin when a pass happens and
 * whose result is published, not what the model would propose.
 */

import { describe, it, expect, spyOn } from 'bun:test';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../../db/sqlite/test-sqlite.test-helpers.ts';
import * as configRepo from './config.repo.ts';
import { saveGeneratedSearchConfig } from './config.repo.ts';
import type { GeneratedSearchInput } from './repo.ts';
import { dayKey, runGeneratedSearchOnce } from './run.ts';
import {
  claimLibraryRun,
  loadLatestRunRecord,
  loadRunRecords,
  type LibraryRunRecord,
} from './run-state.repo.ts';
import { generatedSearchTick, MAX_ATTEMPTS_PER_DAY, startGeneratedSearch } from './schedule.ts';

const LIBRARY = 'lib-a';
const MINUTE = 60_000;

function seedCollection(live: LiveTestDatabase, generatedAt: string): void {
  live.db.run(
    `INSERT INTO generated_searches
       (id, library_id, generated_for, generated_at, model, attempts,
        theme, title, subtitle, query, result_count, cover_asset_id)
     VALUES (?, ?, ?, ?, 'm', 1, 'theme', 'title', NULL, '{}', 12, NULL)`,
    [
      generatedAt.replace(/\D/g, '').padStart(24, '0'),
      LIBRARY,
      generatedAt.slice(0, 10),
      generatedAt,
    ],
  );
}

function fakeCollections(count: number, now: Date, theme = 'theme'): GeneratedSearchInput[] {
  return Array.from({ length: count }, (_, index) => ({
    library_id: LIBRARY,
    generated_for: dayKey(now),
    generated_at: now.toISOString(),
    model: 'm',
    attempts: 1,
    theme: `${theme}-${index}`,
    title: theme,
    subtitle: null,
    query: {},
    result_count: 12,
    cover_asset_id: null,
    first_page_ids: null,
  }));
}

function storedThemes(live: LiveTestDatabase): string[] {
  return (
    live.db.query(`SELECT theme FROM generated_searches ORDER BY theme`).all() as {
      theme: string;
    }[]
  ).map((row) => row.theme);
}

/** A clock the test moves by hand, and a pass that counts its calls. */
function harness(start: string, pass: (call: number) => Promise<number> = async () => 4) {
  let now = new Date(start);
  let calls = 0;
  const deps = {
    now: () => now,
    listLibraries: async () => [LIBRARY],
    runLibrary: async () => fakeCollections(await pass(++calls), now),
  };
  return {
    tick: () => generatedSearchTick(deps),
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
    set: (iso: string) => {
      now = new Date(iso);
    },
    calls: () => calls,
  };
}

async function enable(extra: { dry_run?: boolean } = {}): Promise<void> {
  await saveGeneratedSearchConfig({ paused: false, ...extra });
}

describe('generated-search schedule — restarts', () => {
  it('runs on the first check of a day with no attempt yet', async () => {
    using _live = await createLiveTestDatabase();
    await enable();
    const h = harness('2026-10-12T06:00:00.000Z');

    expect(await h.tick()).toEqual([LIBRARY]);
    expect(h.calls()).toBe(1);
    const record = await loadLatestRunRecord();
    expect(record).toMatchObject({ day: '2026-10-12', outcome: 'saved', saved: 4, attempts: 1 });
    expect(record?.trigger).toBe('schedule');
  });

  it('does nothing on a restart after the day already has a set', async () => {
    using live = await createLiveTestDatabase();
    await enable();
    seedCollection(live, '2026-10-12T01:00:00.000Z');
    const h = harness('2026-10-12T09:00:00.000Z');

    expect(await h.tick()).toEqual([]);
    expect(h.calls()).toBe(0);
  });

  it('gives exactly one run across several restarts in one day', async () => {
    using _live = await createLiveTestDatabase();
    await enable();
    const h = harness('2026-10-12T00:05:00.000Z');
    for (let restart = 0; restart < 8; restart += 1) {
      await h.tick();
      h.advance(2 * 60 * MINUTE);
    }
    expect(h.calls()).toBe(1);
  });

  it('runs again when the day rolls over', async () => {
    using _live = await createLiveTestDatabase();
    await enable();
    const h = harness('2026-10-12T23:50:00.000Z');
    await h.tick();
    h.advance(5 * MINUTE);
    await h.tick();
    expect(h.calls()).toBe(1);

    h.set('2026-10-13T00:05:00.000Z');
    expect(await h.tick()).toEqual([LIBRARY]);
    expect(h.calls()).toBe(2);
    expect((await loadLatestRunRecord())?.day).toBe('2026-10-13');
  });
});

describe('generated-search schedule — failures back off', () => {
  it('waits out a growing backoff after a failure and stops at the daily cap', async () => {
    using _live = await createLiveTestDatabase();
    await enable();
    const h = harness('2026-10-12T06:00:00.000Z', async () => {
      throw new Error('ollama unreachable');
    });

    await h.tick();
    expect(h.calls()).toBe(1);
    expect(await loadLatestRunRecord()).toMatchObject({
      outcome: 'failed',
      error: 'ollama unreachable',
      attempts: 1,
    });

    // Every 15-minute tick inside the first hour is a no-op, restarts included.
    for (let tick = 0; tick < 3; tick += 1) {
      h.advance(15 * MINUTE);
      await h.tick();
    }
    expect(h.calls()).toBe(1);

    h.advance(15 * MINUTE);
    await h.tick();
    expect(h.calls()).toBe(2);

    // The second backoff is two hours.
    h.advance(60 * MINUTE);
    await h.tick();
    expect(h.calls()).toBe(2);
    h.advance(60 * MINUTE);
    await h.tick();
    expect(h.calls()).toBe(MAX_ATTEMPTS_PER_DAY);

    h.advance(6 * 60 * MINUTE);
    await h.tick();
    expect(h.calls()).toBe(MAX_ATTEMPTS_PER_DAY);
    expect((await loadRunRecords()).get(LIBRARY)?.attempts).toBe(MAX_ATTEMPTS_PER_DAY);
  });

  it('backs off after an empty run rather than retrying at once', async () => {
    using _live = await createLiveTestDatabase();
    await enable();
    const h = harness('2026-10-12T06:00:00.000Z', async () => 0);

    await h.tick();
    expect((await loadLatestRunRecord())?.outcome).toBe('empty');
    h.advance(15 * MINUTE);
    await h.tick();
    expect(h.calls()).toBe(1);
    h.advance(45 * MINUTE);
    await h.tick();
    expect(h.calls()).toBe(2);
  });

  it('leaves a fresh running claim alone and retakes a stale one', async () => {
    using _live = await createLiveTestDatabase();
    await enable();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const h = harness('2026-10-12T06:00:00.000Z', async (call) => {
      if (call === 1) await gate;
      return 4;
    });

    const first = h.tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await loadLatestRunRecord())?.outcome).toBe('running');
    h.advance(30 * MINUTE);
    await h.tick();
    expect(h.calls()).toBe(1);

    // Two hours on, a claim still marked running belongs to a dead process.
    h.advance(2 * 60 * MINUTE);
    await h.tick();
    expect(h.calls()).toBe(2);
    expect((await loadLatestRunRecord())?.attempts).toBe(2);
    release();
    await first;
  });
});

describe('generated-search schedule — operator controls', () => {
  it('skips every check while paused', async () => {
    using _live = await createLiveTestDatabase();
    const h = harness('2026-10-12T06:00:00.000Z');
    await h.tick();
    h.advance(24 * 60 * MINUTE);
    await h.tick();
    expect(h.calls()).toBe(0);
    expect(await loadLatestRunRecord()).toBeNull();
  });

  it('only prunes on a paused check, even if the job is enabled mid-check', async () => {
    using live = await createLiveTestDatabase();
    seedCollection(live, '2026-01-01T00:00:00.000Z');
    const paused = await configRepo.loadGeneratedSearchConfig();
    const flip = spyOn(configRepo, 'loadGeneratedSearchConfig')
      .mockResolvedValueOnce(paused)
      .mockResolvedValue({ ...paused, paused: false });
    try {
      const h = harness('2026-10-12T06:00:00.000Z');
      await h.tick();
      expect(h.calls()).toBe(0);
      expect(await loadLatestRunRecord()).toBeNull();
      expect(storedThemes(live)).toEqual([]);
      expect(flip).toHaveBeenCalledTimes(1);
    } finally {
      flip.mockRestore();
    }
  });

  it('counts a dry run as the day only while dry run stays on', async () => {
    using _live = await createLiveTestDatabase();
    await enable({ dry_run: true });
    const h = harness('2026-10-12T06:00:00.000Z');
    await h.tick();
    expect((await loadLatestRunRecord())?.outcome).toBe('dry-run');
    h.advance(15 * MINUTE);
    await h.tick();
    expect(h.calls()).toBe(1);

    await saveGeneratedSearchConfig({ dry_run: false });
    h.advance(15 * MINUTE);
    await h.tick();
    expect(h.calls()).toBe(2);
  });
});

describe('generated-search — a preempted pass publishes nothing', () => {
  function gated() {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    return { gate, release: () => release() };
  }

  it('discards a pass whose stale claim was taken over, leaving only the newer result', async () => {
    using live = await createLiveTestDatabase();
    await enable();
    let now = new Date('2026-10-12T06:00:00.000Z');
    const clock = () => now;
    const a = gated();
    const b = gated();

    const passA = runGeneratedSearchOnce(now, {
      libraries: [LIBRARY],
      clock,
      runLibrary: async () => {
        await a.gate;
        return fakeCollections(4, now, 'A');
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const claimA = (await loadRunRecords()).get(LIBRARY);
    expect(claimA?.outcome).toBe('running');

    now = new Date('2026-10-12T08:01:00.000Z');
    const passB = runGeneratedSearchOnce(now, {
      libraries: [LIBRARY],
      clock,
      runLibrary: async () => {
        await b.gate;
        return fakeCollections(3, now, 'B');
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const claimB = (await loadRunRecords()).get(LIBRARY);
    expect(claimB?.claim_id).not.toBe(claimA?.claim_id);
    expect(claimB?.outcome).toBe('running');

    a.release();
    expect((await passA).saved).toBe(0);
    expect((await loadRunRecords()).get(LIBRARY)).toEqual(claimB);
    expect(storedThemes(live)).toEqual([]);

    b.release();
    expect((await passB).saved).toBe(3);
    expect(storedThemes(live)).toEqual(['B-0', 'B-1', 'B-2']);
    expect((await loadRunRecords()).get(LIBRARY)).toMatchObject({
      claim_id: claimB?.claim_id,
      outcome: 'saved',
      saved: 3,
    });
  });
});

describe('generated-search schedule — one pass per claim across processes', () => {
  /** A pass that stays in flight until released, so two claimants overlap. */
  function gatedPass() {
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    return {
      runLibrary: async () => {
        calls += 1;
        await gate;
        return fakeCollections(4, NOW);
      },
      release: () => release(),
      calls: () => calls,
    };
  }

  const NOW = new Date('2026-10-12T06:00:00.000Z');
  const deps = (runLibrary: () => Promise<GeneratedSearchInput[]>) => ({
    now: () => NOW,
    listLibraries: async () => [LIBRARY],
    runLibrary,
  });

  it('gives exactly one pass to two schedulers checking at once', async () => {
    using _live = await createLiveTestDatabase();
    await enable();
    const pass = gatedPass();
    const both = Promise.all([
      generatedSearchTick(deps(pass.runLibrary)),
      generatedSearchTick(deps(pass.runLibrary)),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    pass.release();
    await both;
    expect(pass.calls()).toBe(1);
  });

  it('gives exactly one pass to Run now and the schedule racing', async () => {
    using _live = await createLiveTestDatabase();
    await enable();
    const pass = gatedPass();
    const both = Promise.all([
      generatedSearchTick(deps(pass.runLibrary)),
      runGeneratedSearchOnce(NOW, {
        force: true,
        libraries: [LIBRARY],
        clock: () => NOW,
        runLibrary: pass.runLibrary,
      }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    pass.release();
    await both;
    expect(pass.calls()).toBe(1);
  });

  it('lets Run now take over a stale claim but not one still in flight', async () => {
    using _live = await createLiveTestDatabase();
    const claim = (startedAt: string): LibraryRunRecord => ({
      library_id: LIBRARY,
      claim_id: startedAt,
      day: '2026-10-12',
      attempts: 1,
      started_at: startedAt,
      finished_at: null,
      outcome: 'running',
      saved: 0,
      error: null,
      trigger: 'schedule',
    });
    expect(await claimLibraryRun(claim('2026-10-12T06:00:00.000Z'), { force: true }, NOW)).toBe(
      true,
    );

    const inFlight = new Date('2026-10-12T07:00:00.000Z');
    expect(await claimLibraryRun(claim(inFlight.toISOString()), { force: true }, inFlight)).toBe(
      false,
    );

    const stale = new Date('2026-10-12T08:30:00.000Z');
    expect(await claimLibraryRun(claim(stale.toISOString()), { force: true }, stale)).toBe(true);
    expect((await loadLatestRunRecord())?.started_at).toBe(stale.toISOString());
  });

  it('refuses a schedule claim when the record changed since it was read', async () => {
    using _live = await createLiveTestDatabase();
    const record: LibraryRunRecord = {
      library_id: LIBRARY,
      claim_id: 'first',
      day: '2026-10-12',
      attempts: 1,
      started_at: '2026-10-12T05:00:00.000Z',
      finished_at: '2026-10-12T05:05:00.000Z',
      outcome: 'failed',
      saved: 0,
      error: 'boom',
      trigger: 'run-now',
    };
    await claimLibraryRun(record, { force: true }, NOW);
    const next = { ...record, started_at: NOW.toISOString(), outcome: 'running' as const };
    expect(await claimLibraryRun(next, { force: false, expectedStartedAt: null }, NOW)).toBe(false);
    expect(
      await claimLibraryRun(next, { force: false, expectedStartedAt: record.started_at }, NOW),
    ).toBe(true);
  });
});

describe('startGeneratedSearch', () => {
  it('checks once shortly after boot, then on every tick, never overlapping', async () => {
    let checks = 0;
    let release: () => void = () => {};
    const handle = startGeneratedSearch({
      bootDelayMs: 0,
      tickMs: 5,
      tick: async () => {
        checks += 1;
        await new Promise<void>((resolve) => (release = resolve));
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(checks).toBe(1);
    release();
    await new Promise((resolve) => setTimeout(resolve, 30));
    handle.stop();
    release();
    expect(checks).toBeGreaterThanOrEqual(2);
  });
});
