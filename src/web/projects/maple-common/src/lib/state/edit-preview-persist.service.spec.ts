// EditPreviewPersistService — edit-time developed-preview persist (#2018).
//
// Covers the write-policy contract (idle debounce, not per-tick; flushAll
// for exit/navigate-away/teardown), the RAW-only gate, and the
// Hosted-vs-server-backed branching (AVIF-when-possible, JPEG fallback only
// on the server-backed path — Hosted has no server to transcode a JPEG, so
// it must defer instead, mirroring `HostedPreviewResolver`'s #2010
// precedent). Real `encodeDevelopedRenderToAvif`/`encodeDevelopedRenderToJpeg`
// run (not mocked — this codebase's Angular unit-test system disallows
// `vi.mock` on relative imports, same reason
// `hosted-preview-resolver.service.spec.ts` doesn't mock the encoder
// either), driven via `vi.stubGlobal` fakes for `OffscreenCanvas` and
// `createImageBitmap` so both the AVIF and JPEG encode paths can be
// exercised deterministically under jsdom (which has neither a working
// canvas 2D context nor `createImageBitmap`).

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Observable, of } from 'rxjs';

import { EditPreviewPersistService } from './edit-preview-persist.service';
import { LibraryStore } from './library-store.service';
import { LibraryCache } from './library-cache.service';
import { MapleCacheService } from '../maple-cache/maple-cache.service';
import { BunApiBackendService } from '../api/bun-api-backend.service';
import { SERVER_WORKSPACE_PERSISTENCE } from '../workspace/workspace-persistence';
import { RawPipelineService } from '../raw-pipeline/raw-pipeline.service';
import { XmpSerializerService } from '../xmp/xmp-serializer.service';
import type { Asset, AssetId } from '../models/asset';
import type { DecodedImage } from '../raw-pipeline/raw-pipeline.types';
import { defaultAdjustmentModel } from '../models/adjustment-model';

// The debounce is 2000ms internally (not exported — an implementation
// detail); advance well past it.
const PAST_DEBOUNCE_MS = 2100;
const settle = (): Promise<void> => Promise.resolve().then(() => Promise.resolve());

class FakeCtx {
  drawImage(): void {}
}
class FakeOffscreenCanvas {
  width: number;
  height: number;
  constructor(width = 0, height = 0) {
    this.width = width;
    this.height = height;
  }
  getContext(): FakeCtx {
    return new FakeCtx();
  }
  convertToBlob(opts: { type: string; quality?: number }): Promise<Blob> {
    return convertToBlobImpl(opts);
  }
}
// Reassigned per test — controls whether the fake canvas can "genuinely"
// encode AVIF (returns the requested type) or silently substitutes PNG
// (the #2010 Chrome-148 reality), mirroring `image-utils.spec.ts`'s pattern.
let convertToBlobImpl: (opts: { type: string; quality?: number }) => Promise<Blob>;

const rawAsset = (filename = 'a.dng') => ({ filename }) as unknown as Asset;
const fakeDecodedImage = (): DecodedImage => ({
  width: 32,
  height: 24,
  rgb: new Uint8Array(32 * 24 * 3),
  asShotTemperature: 6500,
  asShotTint: 0,
});

interface Setup {
  store?: Record<string, unknown>;
  cache?: Record<string, unknown>;
  mapleCache?: Record<string, unknown>;
  api?: Record<string, unknown>;
  pipeline?: Record<string, unknown>;
}

function setup(opts: Setup = {}) {
  const api = {
    putPreview: vi.fn((_path: string, _body: Blob, _contentType: string) => of(undefined)),
    ...opts.api,
  } as {
    putPreview: (path: string, body: Blob, contentType: string) => Observable<unknown>;
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      EditPreviewPersistService,
      {
        provide: LibraryStore,
        useValue: {
          findAsset: () => rawAsset(),
          adjustmentFor: () => () => defaultAdjustmentModel(),
          backend: 'self-hosted',
          absPathFor: () => '/lib/2026/a.dng',
          currentFolder: () => null,
          ...opts.store,
        },
      },
      {
        provide: LibraryCache,
        useValue: {
          bytesFor: () => new Uint8Array([1, 2, 3]),
          bytesForAsset: vi.fn(async () => new Uint8Array([1, 2, 3])),
          ...opts.cache,
        },
      },
      {
        provide: MapleCacheService,
        useValue: { writePreview: vi.fn(async () => {}), ...opts.mapleCache },
      },
      {
        provide: BunApiBackendService,
        useValue: api,
      },
      {
        provide: SERVER_WORKSPACE_PERSISTENCE,
        useValue: {
          writePreview: (path: string, bytes: Blob, contentType: 'image/avif' | 'image/jpeg') =>
            api.putPreview(path, bytes, contentType) as Observable<void>,
        },
      },
      {
        provide: RawPipelineService,
        useValue: { decode: vi.fn(async () => fakeDecodedImage()), ...opts.pipeline },
      },
      { provide: XmpSerializerService, useValue: { serialize: () => '<xmp/>' } },
    ],
  });
  return TestBed.inject(EditPreviewPersistService);
}

// `imageDataToBitmap` constructs a real `ImageData` before handing it to
// `createImageBitmap` — jsdom has neither (see `image-utils.spec.ts`'s
// identical fake for why both need stubbing).
class FakeImageData {
  constructor(
    public data: Uint8ClampedArray,
    public width: number,
    public height: number,
  ) {}
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
  vi.stubGlobal('ImageData', FakeImageData);
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width: 32, height: 24, close: () => {} })),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('EditPreviewPersistService — write policy (idle debounce, not per-tick)', () => {
  it('schedule() does not persist immediately — only after the idle debounce elapses', async () => {
    convertToBlobImpl = async ({ type }) => new Blob(['x'], { type });
    const api = { putPreview: vi.fn(() => of(undefined)) };
    const svc = setup({ api });

    svc.schedule('a' as AssetId);
    await settle();
    expect(api.putPreview).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(PAST_DEBOUNCE_MS);
    expect(api.putPreview).toHaveBeenCalledTimes(1);
  });

  it('re-scheduling before the debounce elapses coalesces into ONE persist, not per-tick', async () => {
    convertToBlobImpl = async ({ type }) => new Blob(['x'], { type });
    const decode = vi.fn(async () => fakeDecodedImage());
    const svc = setup({ pipeline: { decode } });

    // Five "slider ticks" in quick succession, each re-arming the timer.
    for (let i = 0; i < 5; i++) {
      svc.schedule('a' as AssetId);
      await vi.advanceTimersByTimeAsync(200);
    }
    await vi.advanceTimersByTimeAsync(PAST_DEBOUNCE_MS);

    expect(decode).toHaveBeenCalledTimes(1);
  });

  it('flushAll() fires immediately without waiting out the remaining debounce', async () => {
    convertToBlobImpl = async ({ type }) => new Blob(['x'], { type });
    const api = { putPreview: vi.fn(() => of(undefined)) };
    const svc = setup({ api });

    svc.schedule('a' as AssetId);
    svc.flushAll();
    // `flushAll` fires the persist's promise chain immediately (no further
    // setTimeout involved) — `advanceTimersByTimeAsync(0)` drains the
    // microtask queue robustly under fake timers, unlike a couple of bare
    // `Promise.resolve()` hops which isn't deep enough for this chain
    // (decode → encode → firstValueFrom).
    await vi.advanceTimersByTimeAsync(0);

    expect(api.putPreview).toHaveBeenCalledTimes(1);

    // The debounce timer was cleared by flushAll — letting it elapse must
    // NOT trigger a second persist.
    await vi.advanceTimersByTimeAsync(PAST_DEBOUNCE_MS);
    expect(api.putPreview).toHaveBeenCalledTimes(1);
  });
});

describe('EditPreviewPersistService — RAW-only gate', () => {
  it('non-RAW asset: never decodes or writes (decode() ignores xmp for non-RAW — see module doc)', async () => {
    const decode = vi.fn();
    const api = { putPreview: vi.fn(() => of(undefined)) };
    const svc = setup({
      store: { findAsset: () => rawAsset('a.jpg') },
      pipeline: { decode },
      api,
    });

    svc.schedule('a' as AssetId);
    await vi.advanceTimersByTimeAsync(PAST_DEBOUNCE_MS);

    expect(decode).not.toHaveBeenCalled();
    expect(api.putPreview).not.toHaveBeenCalled();
  });

  it('unknown asset (store has no record): never decodes or writes', async () => {
    const decode = vi.fn();
    const svc = setup({ store: { findAsset: () => undefined }, pipeline: { decode } });

    svc.schedule('missing' as AssetId);
    await vi.advanceTimersByTimeAsync(PAST_DEBOUNCE_MS);

    expect(decode).not.toHaveBeenCalled();
  });
});

describe('EditPreviewPersistService — server-backed (Self-Hosted)', () => {
  it('encodes genuine AVIF and PUTs it when this browser can encode AVIF', async () => {
    convertToBlobImpl = async ({ type }) => new Blob(['x'], { type });
    const api = {
      putPreview: vi.fn((_path: string, _body: Blob, _contentType: string) => of(undefined)),
    };
    const svc = setup({ store: { backend: 'self-hosted' }, api });

    svc.schedule('a' as AssetId);
    await vi.advanceTimersByTimeAsync(PAST_DEBOUNCE_MS);

    expect(api.putPreview).toHaveBeenCalledTimes(1);
    const [path, body, contentType] = api.putPreview.mock.calls[0];
    expect(path).toBe('/lib/2026/a.dng');
    expect(body.type).toBe('image/avif');
    expect(contentType).toBe('image/avif');
  });

  it('falls back to a JPEG PUT when this browser cannot genuinely encode AVIF (#2018 — never deferred here)', async () => {
    // Silent substitution: the fake "encoder" returns PNG for an AVIF
    // request — the #2010 Chrome-148 reality `canEncodeAvif()` detects.
    convertToBlobImpl = async ({ type }) =>
      new Blob(['x'], { type: type === 'image/avif' ? 'image/png' : type });
    const api = {
      putPreview: vi.fn((_path: string, _body: Blob, _contentType: string) => of(undefined)),
    };
    const svc = setup({ store: { backend: 'self-hosted' }, api });

    svc.schedule('a' as AssetId);
    await vi.advanceTimersByTimeAsync(PAST_DEBOUNCE_MS);

    expect(api.putPreview).toHaveBeenCalledTimes(1);
    const [, body, contentType] = api.putPreview.mock.calls[0];
    expect(body.type).toBe('image/jpeg');
    expect(contentType).toBe('image/jpeg');
  });

  it('no known on-disk path yet: no-ops without calling putPreview', async () => {
    convertToBlobImpl = async ({ type }) => new Blob(['x'], { type });
    const api = { putPreview: vi.fn(() => of(undefined)) };
    const svc = setup({ store: { backend: 'self-hosted', absPathFor: () => undefined }, api });

    svc.schedule('a' as AssetId);
    await vi.advanceTimersByTimeAsync(PAST_DEBOUNCE_MS);

    expect(api.putPreview).not.toHaveBeenCalled();
  });
});

describe('EditPreviewPersistService — Hosted (File System Access folder handle)', () => {
  it('writes genuine AVIF via MapleCacheService when the folder is writable and the id resolves', async () => {
    convertToBlobImpl = async ({ type }) => new Blob(['x'], { type });
    const writePreview = vi.fn(
      async (_folder: unknown, _dir: string, _filename: string, _blob: Blob) => {},
    );
    const folder = { write: true };
    const svc = setup({
      store: { backend: 'hosted', currentFolder: () => folder },
      mapleCache: { writePreview },
    });

    svc.schedule('lib:2026/a.dng' as AssetId);
    await vi.advanceTimersByTimeAsync(PAST_DEBOUNCE_MS);

    expect(writePreview).toHaveBeenCalledTimes(1);
    expect(writePreview).toHaveBeenCalledWith(folder, '2026', 'a.dng', expect.any(Blob));
    const written = writePreview.mock.calls[0][3];
    expect(written.type).toBe('image/avif');
  });

  it('browser cannot genuinely encode AVIF: writes NOTHING (no server to fall back to — #2010 precedent)', async () => {
    convertToBlobImpl = async ({ type }) =>
      new Blob(['x'], { type: type === 'image/avif' ? 'image/png' : type });
    const writePreview = vi.fn();
    const svc = setup({
      store: { backend: 'hosted', currentFolder: () => ({ write: true }) },
      mapleCache: { writePreview },
    });

    svc.schedule('lib:2026/a.dng' as AssetId);
    await vi.advanceTimersByTimeAsync(PAST_DEBOUNCE_MS);

    expect(writePreview).not.toHaveBeenCalled();
  });

  it('read-only folder: writes nothing', async () => {
    convertToBlobImpl = async ({ type }) => new Blob(['x'], { type });
    const writePreview = vi.fn();
    const svc = setup({
      store: { backend: 'hosted', currentFolder: () => ({ write: false }) },
      mapleCache: { writePreview },
    });

    svc.schedule('lib:2026/a.dng' as AssetId);
    await vi.advanceTimersByTimeAsync(PAST_DEBOUNCE_MS);

    expect(writePreview).not.toHaveBeenCalled();
  });

  it('no addressable folder location (e.g. an imported asset id): writes nothing', async () => {
    convertToBlobImpl = async ({ type }) => new Blob(['x'], { type });
    const writePreview = vi.fn();
    const svc = setup({
      store: { backend: 'hosted', currentFolder: () => ({ write: true }) },
      mapleCache: { writePreview },
    });

    svc.schedule('fs:/abs/path/a.dng' as AssetId);
    await vi.advanceTimersByTimeAsync(PAST_DEBOUNCE_MS);

    expect(writePreview).not.toHaveBeenCalled();
  });
});

describe('EditPreviewPersistService — failure isolation', () => {
  it('a decode failure is caught and logged, never thrown to the caller', async () => {
    const decode = vi.fn(async () => {
      throw new Error('boom');
    });
    const svc = setup({ pipeline: { decode } });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      svc.schedule('a' as AssetId);
      await vi.advanceTimersByTimeAsync(PAST_DEBOUNCE_MS);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
