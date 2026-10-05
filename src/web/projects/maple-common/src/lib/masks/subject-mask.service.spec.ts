// subject-mask.service.spec.ts — the web detection source (#3300 slice 3):
// detect gating, cache → server → register resolution, tolerance, release.
//
// The lazily-imported server client (`subject-mask-server-bridge.ts`)
// resolves through the injector, so a TestBed fake stands in for HttpClient
// (the lens-profile-import spec's pattern) — the HTTP wire itself is pinned
// in `subject-mask-server.service.spec.ts`.

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { LIBRARY_BACKEND } from '../api/library-backend.token';
import { RawPipelineService } from '../raw-pipeline/raw-pipeline.service';
import type { MaskRasterUpload } from '../raw-pipeline/raw-pipeline.mask-raster.types';
import type { BitmapMask, BitmapRecipe, LocalAdjustment } from '../models/local-adjustment';
import {
  SUBJECT_MASK_CACHE,
  InMemorySubjectMaskCache,
  type SubjectMaskRasterCache,
} from './subject-mask-cache';
import { SUBJECT_MASK_PNG_DECODER } from './subject-mask-png';
import { SubjectMaskServer } from './subject-mask-server.service';
import { SubjectMaskError, SubjectMaskService, bitmapDigestsIn } from './subject-mask.service';

const RECIPE = (digest: string): BitmapRecipe => ({
  person: 0,
  facialSkin: true,
  bodySkin: true,
  model: 'maple-server-person-instance/1',
  digest,
});

const bitmapLeaf = (digest: string): BitmapMask => ({
  kind: 'bitmap',
  recipe: RECIPE(digest),
  rasterId: 0,
});

const bitmapLayer = (digest: string): LocalAdjustment => ({
  mask: bitmapLeaf(digest),
  adjustments: {},
});

const httpFailure = (status: number) => throwError(() => ({ status }));

describe('bitmapDigestsIn', () => {
  it('collects leaf and group bitmap digests, deduplicated', () => {
    expect(
      bitmapDigestsIn([
        bitmapLayer('aaaaaaaaaaaaaaaa'),
        {
          mask: { kind: 'linear', start: { x: 0, y: 0 }, end: { x: 1, y: 1 }, feather: 0 },
          adjustments: {},
        },
        {
          mask: {
            kind: 'group',
            components: [
              { mask: bitmapLeaf('bbbbbbbbbbbbbbbb'), combine: 'add', invert: false },
              { mask: bitmapLeaf('aaaaaaaaaaaaaaaa'), combine: 'add', invert: false },
            ],
            opacity: 1,
            invert: false,
          },
          adjustments: {},
        },
      ]),
    ).toEqual(['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb']);
  });
});

describe('SubjectMaskService', () => {
  let svc: SubjectMaskService;
  let cache: SubjectMaskRasterCache;
  let server: {
    detectPersons: ReturnType<typeof vi.fn>;
    fetchRasterBytes: ReturnType<typeof vi.fn>;
  };
  let uploads: MaskRasterUpload[];
  let released: number[];
  let decoded: ArrayBuffer[];
  let epoch: number;
  let failDecode: (png: ArrayBuffer) => boolean;

  function configure(backend: 'hosted' | 'self-hosted'): void {
    uploads = [];
    released = [];
    decoded = [];
    epoch = 0;
    failDecode = () => false;
    let nextId = 1;
    server = {
      detectPersons: vi.fn(() => of({ model: 'm/1', persons: [] })),
      fetchRasterBytes: vi.fn(() => of(new ArrayBuffer(12))),
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: LIBRARY_BACKEND, useValue: backend },
        { provide: SUBJECT_MASK_CACHE, useClass: InMemorySubjectMaskCache },
        { provide: SubjectMaskServer, useValue: server },
        {
          provide: SUBJECT_MASK_PNG_DECODER,
          useValue: (png: ArrayBuffer) => {
            decoded.push(png);
            if (failDecode(png)) return Promise.reject(new Error('bad png'));
            return Promise.resolve({ width: 4, height: 2, data: new Uint8Array(8).fill(7) });
          },
        },
        {
          provide: RawPipelineService,
          useValue: {
            registerMaskRaster: (upload: MaskRasterUpload) => {
              uploads.push(upload);
              const id = nextId++;
              return Promise.resolve(id);
            },
            releaseMaskRaster: (id: number) => void released.push(id),
            currentWorkerEpoch: () => epoch,
          },
        },
      ],
    });
    svc = TestBed.inject(SubjectMaskService);
    cache = TestBed.inject(SUBJECT_MASK_CACHE);
  }

  describe('detect', () => {
    it('throws unsupported on Hosted without touching the server', async () => {
      configure('hosted');
      const failure = await svc.detect('asset-1').then(
        () => null,
        (err: unknown) => err,
      );
      expect(failure).toBeInstanceOf(SubjectMaskError);
      expect((failure as SubjectMaskError).kind).toBe('unsupported');
      expect(server.detectPersons).not.toHaveBeenCalled();
    });

    it('returns the server model + persons on Self Hosted', async () => {
      configure('self-hosted');
      server.detectPersons.mockReturnValue(
        of({ model: 'm/1', persons: [{ person: 0, bbox: { x: 0, y: 0, width: 1, height: 1 } }] }),
      );
      const detection = await svc.detect('asset-1');
      expect(server.detectPersons).toHaveBeenCalledWith('asset-1');
      expect(detection.model).toBe('m/1');
      expect(detection.persons.map((p) => p.person)).toEqual([0]);
    });

    it('maps a detect 404 to unavailable and a 500 to failed', async () => {
      configure('self-hosted');
      server.detectPersons.mockReturnValueOnce(httpFailure(404));
      await expect(svc.detect('asset-1')).rejects.toMatchObject({ kind: 'unavailable' });
      server.detectPersons.mockReturnValueOnce(httpFailure(500));
      await expect(svc.detect('asset-1')).rejects.toMatchObject({ kind: 'failed' });
    });
  });

  describe('ensureRaster', () => {
    const DIGEST = '1ebe481c3e3e8053';

    beforeEach(() => configure('self-hosted'));

    it('registers the cached PNG without fetching', async () => {
      const png = new ArrayBuffer(8);
      await cache.put({ digest: DIGEST, width: 4, height: 2, png });
      const id = await svc.ensureRaster(RECIPE(DIGEST));
      expect(id).toBe(1);
      expect(decoded).toEqual([png]);
      expect(server.fetchRasterBytes).not.toHaveBeenCalled();
      expect(uploads).toHaveLength(1);
      expect(uploads[0]).toMatchObject({ digest: DIGEST, width: 4, height: 2 });
      expect(uploads[0]?.data).toHaveLength(8);
    });

    it('memoizes the id within one worker epoch', async () => {
      await cache.put({ digest: DIGEST, width: 4, height: 2, png: new ArrayBuffer(8) });
      expect(await svc.ensureRaster(RECIPE(DIGEST))).toBe(1);
      expect(await svc.ensureRaster(RECIPE(DIGEST))).toBe(1);
      expect(uploads).toHaveLength(1);
    });

    it('fetches, registers and caches on a miss', async () => {
      const png = new ArrayBuffer(12);
      server.fetchRasterBytes.mockReturnValue(of(png));
      expect(await svc.ensureRaster(RECIPE(DIGEST))).toBe(1);
      expect(server.fetchRasterBytes).toHaveBeenCalledWith(DIGEST);
      expect(decoded).toEqual([png]);
      expect(uploads).toHaveLength(1);
      expect(await cache.get(DIGEST)).toMatchObject({ digest: DIGEST, width: 4, height: 2 });
    });

    it('shares one fetch between concurrent misses', async () => {
      const [first, second] = await Promise.all([
        svc.ensureRaster(RECIPE(DIGEST)),
        svc.ensureRaster(RECIPE(DIGEST)),
      ]);
      expect(first).toBe(1);
      expect(second).toBe(1);
      expect(server.fetchRasterBytes).toHaveBeenCalledTimes(1);
      expect(uploads).toHaveLength(1);
    });

    it('refetches when the cached PNG fails to decode', async () => {
      const bad = new ArrayBuffer(4);
      const good = new ArrayBuffer(12);
      failDecode = (png) => png === bad;
      server.fetchRasterBytes.mockReturnValue(of(good));
      await cache.put({ digest: DIGEST, width: 1, height: 1, png: bad });
      expect(await svc.ensureRaster(RECIPE(DIGEST))).toBe(1);
      expect(decoded).toEqual([bad, good]);
      expect(uploads).toHaveLength(1);
    });

    it('maps a raster 404 to unavailable', async () => {
      server.fetchRasterBytes.mockReturnValue(httpFailure(404));
      await expect(svc.ensureRaster(RECIPE(DIGEST))).rejects.toMatchObject({
        kind: 'unavailable',
      });
      expect(uploads).toHaveLength(0);
    });

    it('re-registers from the cache after the worker is retired', async () => {
      await cache.put({ digest: DIGEST, width: 4, height: 2, png: new ArrayBuffer(8) });
      expect(await svc.ensureRaster(RECIPE(DIGEST))).toBe(1);
      epoch += 1;
      expect(await svc.ensureRaster(RECIPE(DIGEST))).toBe(2);
      expect(uploads).toHaveLength(2);
      expect(server.fetchRasterBytes).not.toHaveBeenCalled();
    });

    it('throws unsupported on Hosted with an empty cache, serves Hosted from it', async () => {
      TestBed.resetTestingModule();
      configure('hosted');
      await expect(svc.ensureRaster(RECIPE(DIGEST))).rejects.toMatchObject({
        kind: 'unsupported',
      });
      await cache.put({ digest: DIGEST, width: 4, height: 2, png: new ArrayBuffer(8) });
      expect(await svc.ensureRaster(RECIPE(DIGEST))).toBe(1);
      expect(uploads).toHaveLength(1);
    });
  });

  describe('ensureBitmapRasters', () => {
    beforeEach(() => configure('self-hosted'));

    it('registers every digest and tolerates the ones it cannot produce', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        await cache.put({
          digest: 'aaaaaaaaaaaaaaaa',
          width: 4,
          height: 2,
          png: new ArrayBuffer(8),
        });
        server.fetchRasterBytes.mockReturnValue(httpFailure(404));
        await svc.ensureBitmapRasters([
          bitmapLayer('aaaaaaaaaaaaaaaa'),
          bitmapLayer('bbbbbbbbbbbbbbbb'),
        ]);
        expect(uploads.map((u) => u.digest)).toEqual(['aaaaaaaaaaaaaaaa']);
        expect(warn).toHaveBeenCalledTimes(1);
      } finally {
        warn.mockRestore();
      }
    });

    it('is a no-op for layers without bitmap masks', async () => {
      await svc.ensureBitmapRasters([
        {
          mask: { kind: 'linear', start: { x: 0, y: 0 }, end: { x: 1, y: 1 }, feather: 0 },
          adjustments: {},
        },
      ]);
      expect(uploads).toHaveLength(0);
      expect(server.fetchRasterBytes).not.toHaveBeenCalled();
    });
  });

  describe('releaseDigests', () => {
    beforeEach(() => configure('self-hosted'));

    it('releases only digests no remaining layer names', async () => {
      await cache.put({ digest: 'aaaaaaaaaaaaaaaa', width: 4, height: 2, png: new ArrayBuffer(8) });
      await cache.put({ digest: 'bbbbbbbbbbbbbbbb', width: 4, height: 2, png: new ArrayBuffer(8) });
      await svc.ensureRaster(RECIPE('aaaaaaaaaaaaaaaa'));
      await svc.ensureRaster(RECIPE('bbbbbbbbbbbbbbbb'));
      svc.releaseDigests(
        ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb'],
        [bitmapLayer('bbbbbbbbbbbbbbbb')],
      );
      expect(released).toEqual([1]);
      // Releasing again is a no-op — the memo is gone.
      svc.releaseDigests(['aaaaaaaaaaaaaaaa'], []);
      expect(released).toEqual([1]);
    });
  });
});
