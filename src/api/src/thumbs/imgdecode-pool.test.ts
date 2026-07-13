/**
 * imgdecode pool unit + integration tests.
 *
 * Unit tests: drive an injected fake `ImgDecodeWorker` (no real child) to
 * verify dispatch, result-forwarding, and crash handling.
 *
 * Integration test: spawn the real child and render a tiny synthetic JPEG to
 * a temp file — confirms the IPC round-trip, the sharp pipeline, and the
 * on-disk output contract.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import sharp from 'sharp';
import {
  _createImgdecodePoolForTests,
  type ImgDecodeWorker,
  type ImgDecodeWorkerFactory,
} from './imgdecode-pool.ts';

// ── Fake worker ────────────────────────────────────────────────────────────

interface PostedMsg {
  type: string;
  id: number;
  srcPath: string;
  outPath: string;
  maxPx: number;
  quality: number;
  ext: string;
}

/** Controllable fake that records posted messages and exposes `respond` / `crash`. */
class FakeImgDecodeWorker implements ImgDecodeWorker {
  static all: FakeImgDecodeWorker[] = [];
  terminated = false;
  posted: PostedMsg[] = [];
  private msgCb: ((e: { data: unknown }) => void) | null = null;
  private errCb: ((e: { message?: string }) => void) | null = null;

  constructor() {
    FakeImgDecodeWorker.all.push(this);
  }

  postMessage(msg: unknown): void {
    this.posted.push(msg as PostedMsg);
  }

  terminate(): void {
    this.terminated = true;
  }

  addEventListener(type: 'message' | 'error', cb: (e: never) => void): void {
    if (type === 'message') this.msgCb = cb as (e: { data: unknown }) => void;
    else this.errCb = cb as (e: { message?: string }) => void;
  }

  /** Simulate a successful (or failed) render response for the most-recently-posted request. */
  respond(ok: boolean, error?: string): void {
    const last = this.posted[this.posted.length - 1];
    this.msgCb?.({ data: { type: 'render', id: last.id, ok, error } });
  }

  /** Simulate an unexpected child exit (crash). */
  crash(message = 'boom'): void {
    this.errCb?.({ message });
  }
}

function freshFactory(): { factory: ImgDecodeWorkerFactory; workers: FakeImgDecodeWorker[] } {
  FakeImgDecodeWorker.all = [];
  return { factory: () => new FakeImgDecodeWorker(), workers: FakeImgDecodeWorker.all };
}

function render(pool: ReturnType<typeof _createImgdecodePoolForTests>) {
  return pool.renderImageThumbToFile('/src.jpg', '/out.jpg', 512, 82, 'jpg');
}

// ── Unit tests ─────────────────────────────────────────────────────────────

describe('ImgDecodePool — dispatch', () => {
  it('spawns lazily: no worker until the first request', () => {
    const { factory, workers } = freshFactory();
    const pool = _createImgdecodePoolForTests({ workerFactory: factory });
    expect(workers.length).toBe(0);
    void render(pool);
    expect(workers.length).toBe(1);
  });

  it('reuses the same worker for consecutive requests', () => {
    const { factory, workers } = freshFactory();
    const pool = _createImgdecodePoolForTests({ workerFactory: factory });

    void render(pool);
    workers[0].respond(true);

    void render(pool);
    workers[0].respond(true);

    // Only one child was ever spawned.
    expect(workers.length).toBe(1);
  });

  it('resolves { ok: true } when the child replies ok', async () => {
    const { factory, workers } = freshFactory();
    const pool = _createImgdecodePoolForTests({ workerFactory: factory });
    const p = render(pool);
    workers[0].respond(true);
    await expect(p).resolves.toEqual({ ok: true, error: undefined });
  });

  it('resolves { ok: false, error } when the child reports failure', async () => {
    const { factory, workers } = freshFactory();
    const pool = _createImgdecodePoolForTests({ workerFactory: factory });
    const p = render(pool);
    workers[0].respond(false, 'bad image');
    await expect(p).resolves.toEqual({ ok: false, error: 'bad image' });
  });

  it('posts the correct message shape to the child', () => {
    const { factory, workers } = freshFactory();
    const pool = _createImgdecodePoolForTests({ workerFactory: factory });
    void pool.renderImageThumbToFile('/a/b.heic', '/a/b.jpg', 256, 75, 'heic');
    expect(workers[0].posted[0]).toMatchObject({
      type: 'render',
      srcPath: '/a/b.heic',
      outPath: '/a/b.jpg',
      maxPx: 256,
      quality: 75,
      ext: 'heic',
    });
  });

  it('handles concurrent requests via the same child', async () => {
    const { factory, workers } = freshFactory();
    const pool = _createImgdecodePoolForTests({ workerFactory: factory });

    const a = render(pool);
    const b = pool.renderImageThumbToFile('/c.png', '/c.jpg', 128, 82, 'png');
    // Both are in-flight; only one child spawned.
    expect(workers.length).toBe(1);
    expect(workers[0].posted.length).toBe(2);

    // Resolve in reverse order.
    // Reply for b (id 2)
    workers[0].msgCb?.({ data: { type: 'render', id: workers[0].posted[1].id, ok: true } });
    await expect(b).resolves.toEqual({ ok: true, error: undefined });

    // Reply for a (id 1)
    workers[0].msgCb?.({ data: { type: 'render', id: workers[0].posted[0].id, ok: true } });
    await expect(a).resolves.toEqual({ ok: true, error: undefined });
  });
});

describe('ImgDecodePool — crash isolation', () => {
  it('rejects all pending calls when the child crashes', async () => {
    const { factory, workers } = freshFactory();
    const pool = _createImgdecodePoolForTests({ workerFactory: factory });

    const a = render(pool);
    const b = render(pool);

    workers[0].crash('segfault');

    await expect(a).rejects.toThrow(/worker errored/);
    await expect(b).rejects.toThrow(/worker errored/);
  });

  it('terminates the crashed worker', async () => {
    const { factory, workers } = freshFactory();
    const pool = _createImgdecodePoolForTests({ workerFactory: factory });
    const p = render(pool);
    workers[0].crash();
    await expect(p).rejects.toThrow();
    expect(workers[0].terminated).toBe(true);
  });

  it('the parent survives a crash and succeeds on the next request', async () => {
    const { factory, workers } = freshFactory();
    const pool = _createImgdecodePoolForTests({ workerFactory: factory });

    // First call: child crashes.
    const first = render(pool);
    workers[0].crash('kaboom');
    await expect(first).rejects.toThrow(/worker errored/);

    // Second call spawns a fresh child (index 1) and succeeds.
    const second = render(pool);
    expect(workers.length).toBe(2); // a new child was spawned
    workers[1].respond(true);
    await expect(second).resolves.toEqual({ ok: true, error: undefined });
  });
});

// ── Integration test ───────────────────────────────────────────────────────

describe('imgdecode child — integration', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'imgdecode-int-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    // Terminate the real child and clear the singleton so the test process
    // exits cleanly — `_resetImgdecodePoolForTests` only nulls the reference,
    // so we call shutdown first to actually kill the spawned child.
    const { imgdecodePool, _resetImgdecodePoolForTests } = await import('./imgdecode-pool.ts');
    try {
      imgdecodePool().shutdown();
    } catch {
      // child may already be gone
    }
    _resetImgdecodePoolForTests();
  });

  it('renders a synthetic JPEG via the real child and writes the output file', async () => {
    // Create a minimal 4×4 RGB JPEG via sharp in this test process.
    const src = path.join(dir, 'src.jpg');
    const out = path.join(dir, 'out.avif');
    const jpgBuf = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 200, g: 100, b: 50 } },
    })
      .jpeg()
      .toBuffer();
    await writeFile(src, jpgBuf);

    const { imgdecodePool, _resetImgdecodePoolForTests } = await import('./imgdecode-pool.ts');
    _resetImgdecodePoolForTests(); // ensure a fresh pool for this test

    const result = await imgdecodePool().renderImageThumbToFile(src, out, 256, 55, 'jpg');

    expect(result.ok).toBe(true);
    // The output file must exist and be a valid AVIF.
    const s = await stat(out);
    expect(s.size).toBeGreaterThan(0);
    const meta = await sharp(out).metadata();
    // sharp has no distinct "avif" format label — AVIF is a HEIF profile, so
    // a real AVIF file reports format:"heif" here.
    expect(meta.format).toBe('heif');
  }, 15_000 /* generous timeout for child spawn + render */);
});
