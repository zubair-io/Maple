/**
 * The daily schedule against real SQLite with an injected clock (#4602).
 *
 * A "restart" here is simply another tick: the schedule keeps no memory
 * between ticks, so a fresh process and the next tick of a running one ask the
 * same persisted question. The per-library LLM pass is replaced by a counter,
 * so these tests pin when a pass happens, not what it produces.
 */

import { describe, it, expect } from 'bun:test';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../../db/sqlite/test-sqlite.test-helpers.ts';
import { saveGeneratedSearchConfig } from './config.repo.ts';
import { loadLatestRunRecord, loadRunRecords } from './run-state.repo.ts';
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

/** A clock the test moves by hand, and a pass that counts its calls. */
function harness(start: string, pass: (call: number) => Promise<number> = async () => 4) {
  let now = new Date(start);
  let calls = 0;
  const deps = {
    now: () => now,
    listLibraries: async () => [LIBRARY],
    runLibrary: async () => pass(++calls),
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
