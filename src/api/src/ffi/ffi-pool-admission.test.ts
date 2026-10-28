/**
 * The FFI pool under a capped decode memory budget (#5467): RAW-lane work
 * reserves its estimated peak before it reaches a child, and every way a
 * request settles gives the reservation back.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { closeSync, mkdtempSync, openSync, rmSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _createFfiPoolForTests, type PoolWorker } from './ffi-pool.ts';
import { DecodeMemoryBudget, DecodeMemoryBudgetError } from './decode-memory-budget.ts';

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

class FakeWorker implements PoolWorker {
  terminated = false;
  posted: Array<{ type: string; id: number }> = [];
  private msgCb: ((e: { data: unknown }) => void) | null = null;
  private errCb: ((e: { message?: string }) => void) | null = null;

  postMessage(msg: unknown): void {
    this.posted.push(msg as { type: string; id: number });
  }

  terminate(): void {
    this.terminated = true;
  }

  addEventListener(type: 'message' | 'error', cb: (e: never) => void): void {
    if (type === 'message') this.msgCb = cb as (e: { data: unknown }) => void;
    else this.errCb = cb as (e: { message?: string }) => void;
  }

  reply(): void {
    const last = this.posted.at(-1)!;
    this.msgCb?.({ data: { type: last.type, id: last.id, ok: true } });
  }

  crash(): void {
    this.errCb?.({ message: 'ffi-decode child died — signal=SIGKILL' });
  }
}

const dirs: string[] = [];

/** A sparse file of `bytes`: the estimator reads only its size. */
function rawOfSize(bytes: number): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'maple-admission-'));
  dirs.push(dir);
  const file = path.join(dir, 'frame.cr2');
  closeSync(openSync(file, 'w'));
  truncateSync(file, bytes);
  return file;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function harness(limitBytes: number) {
  const workers: FakeWorker[] = [];
  const budget = new DecodeMemoryBudget();
  budget.configure(limitBytes);
  const pool = _createFfiPoolForTests({
    workerFactory: () => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    },
    budget,
  });
  pool.setPoolSize(4);
  return { pool, budget, workers };
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(1);
  expect(check()).toBe(true);
}

const posted = (workers: FakeWorker[]) => workers.reduce((n, w) => n + w.posted.length, 0);

describe('FfiWorkerPool — decode memory admission', () => {
  it('holds a develop that does not fit until the running one answers', async () => {
    const raw = rawOfSize(64 * MIB);
    const { pool, budget, workers } = harness(10 * GIB);
    const first = pool.renderDevelopJpegToFile(raw, null, '/a.jpg', 1280);
    const second = pool.renderDevelopJpegToFile(raw, null, '/b.jpg', 1280);
    await until(() => posted(workers) === 1);
    await Bun.sleep(5);
    expect(posted(workers)).toBe(1);
    expect(budget.snapshot()).toMatchObject({
      reservedBytes: 8 * GIB,
      running: 1,
      waiting: 1,
    });

    workers[0]!.reply();
    expect(await first).toBe(true);
    await until(() => posted(workers) === 2);
    workers.at(-1)!.reply();
    expect(await second).toBe(true);
    expect(budget.snapshot()).toMatchObject({
      reservedBytes: 0,
      running: 0,
      waiting: 0,
    });
  });

  it('retires the child after a develop, so its freed heap is not carried into the next decode', async () => {
    const raw = rawOfSize(64 * MIB);
    const { pool, workers } = harness(20 * GIB);
    const develop = pool.renderDevelopJpegToFile(raw, null, '/a.jpg', 1280);
    await until(() => posted(workers) === 1);
    workers[0]!.reply();
    await develop;
    expect(workers[0]!.terminated).toBe(true);
    expect(pool.stats().spawned).toBe(0);
  });

  it('keeps the child after an extraction', async () => {
    const raw = rawOfSize(32 * MIB);
    const { pool, workers } = harness(20 * GIB);
    const thumb = pool.renderThumbnailAvifToFile(raw, '/t.avif', 512);
    await until(() => posted(workers) === 1);
    workers[0]!.reply();
    await thumb;
    expect(workers[0]!.terminated).toBe(false);
  });

  it('gives the reservation back when the child is killed mid-decode', async () => {
    const raw = rawOfSize(64 * MIB);
    const { pool, budget, workers } = harness(10 * GIB);
    const killed = pool.renderDevelopJpegToFile(raw, null, '/a.jpg', 1280);
    const next = pool.renderDevelopJpegToFile(raw, null, '/b.jpg', 1280);
    await until(() => posted(workers) === 1);
    workers[0]!.crash();
    await expect(killed).rejects.toThrow('SIGKILL');
    await until(() => posted(workers) === 2);
    workers.at(-1)!.reply();
    await next;
    expect(budget.snapshot().reservedBytes).toBe(0);
  });

  it('rejects a decode larger than the whole budget without spawning a child', async () => {
    const raw = rawOfSize(64 * MIB);
    const { pool, budget, workers } = harness(2 * GIB);
    await expect(pool.renderDevelopJpegToFile(raw, null, '/a.jpg', 1280)).rejects.toBeInstanceOf(
      DecodeMemoryBudgetError,
    );
    expect(workers).toHaveLength(0);
    expect(budget.snapshot().reservedBytes).toBe(0);
  });

  it('lets extractions run side by side while a develop waits its turn', async () => {
    const raw = rawOfSize(64 * MIB);
    const { pool, workers } = harness(10 * GIB);
    const develop = pool.renderDevelopJpegToFile(raw, null, '/a.jpg', 1280);
    await until(() => posted(workers) === 1);
    const thumbs = [1, 2].map((n) => pool.renderThumbnailAvifToFile(raw, `/t${n}.avif`, 512));
    await until(() => posted(workers) === 3);
    for (const w of workers.slice(1)) w.reply();
    await Promise.all(thumbs);
    workers[0]!.reply();
    await develop;
  });

  it('rejects decodes still waiting for memory when the pool shuts down', async () => {
    const raw = rawOfSize(64 * MIB);
    const { pool, budget, workers } = harness(10 * GIB);
    const outcomes = [1, 2].map((n) =>
      pool.renderDevelopJpegToFile(raw, null, `/${n}.jpg`, 1280).catch((e: Error) => e.message),
    );
    await until(() => posted(workers) === 1 && budget.snapshot().waiting === 1);
    pool.shutdown();
    expect(await Promise.all(outcomes)).toEqual([
      'ffi-pool: shutting down',
      'ffi-pool: shutting down',
    ]);
    expect(budget.snapshot()).toMatchObject({ reservedBytes: 0, waiting: 0 });
  });
});
