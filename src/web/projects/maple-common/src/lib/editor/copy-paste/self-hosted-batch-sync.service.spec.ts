import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LibraryStateService } from '../../state/library-state.service';
import { LibraryStore } from '../../state/library-store.service';
import { XmpAdjustmentRestoreService } from '../../xmp/xmp-adjustment-restore.service';
import { BatchPreviewService } from './batch-preview.service';
import { SelfHostedBatchSyncService } from './self-hosted-batch-sync.service';
import { buildGroupPatch } from './adjustment-groups';
import { defaultAdjustmentModel, type AdjustmentModel } from '../../models/adjustment-model';

const key = 'maple.batch-sync:/api';
const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
const view = (
  status: string,
  applied: string[] = [],
  failed: { id: string; reason: string }[] = [],
  remaining: string[] = [],
) => ({
  id: 'saved',
  status,
  progress: {
    current: applied.length + failed.length,
    total: applied.length + failed.length + remaining.length,
  },
  result: { applied, failed, remaining },
  error: null,
});

describe('Self Hosted batch sync recovery', () => {
  let http: HttpTestingController;
  const invalidate = vi.fn();
  const readPersisted = vi.fn();
  let models: ReturnType<typeof signal<Map<string, AdjustmentModel>>>;
  let merge: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.removeItem(key);
    invalidate.mockReset();
    readPersisted.mockReset();
    models = signal(new Map());
    merge = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: LibraryStateService, useValue: { flushPendingXmpWrites: async () => {} } },
        {
          provide: LibraryStore,
          useValue: {
            absPathFor: (id: string) => `/photos/${id}.jpg`,
            adjustmentModels: models,
            assets: signal([]),
            mergePersistedAdjustment: merge,
          },
        },
        { provide: XmpAdjustmentRestoreService, useValue: { invalidateForAsset: invalidate } },
        { provide: BatchPreviewService, useValue: { readPersisted } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => {
    http.verify();
    localStorage.removeItem(key);
  });

  it('sends the explicit camera-baseline correction with the selected WB fields', async () => {
    const service = TestBed.inject(SelfHostedBatchSyncService);
    const source = {
      ...defaultAdjustmentModel(),
      temperature: 8550,
      tint: 24,
      whiteBalancePreset: 'Custom' as const,
      wbSource: 'Manual' as const,
    };
    const run = service.apply(
      ['a'],
      {
        temperature: source.temperature,
        tint: source.tint,
        whiteBalancePreset: 'Custom',
        wbScaleVersion: 5,
      },
      {
        source,
        sourceAssetId: 'source',
        groups: ['white_balance'],
        relativeWhiteBalance: true,
        sourceBaseline: { temperature: 7350, tint: 14 },
      },
    );
    await settle();
    const create = http.expectOne('/api/jobs');
    expect(create.request.body.payload.relativeWhiteBalance).toEqual({
      temperature: 1200,
      tint: 10,
    });
    expect(create.request.body.payload.patch.attributes['crs:Temperature']).toBe('8550');
    create.flush({ id: 'relative' });
    await settle();
    http.expectOne('/api/jobs/relative?summary=1').flush(view('done', ['a']));
    expect((await run)?.applied).toEqual(['a']);
  });

  it('declares the validated current scale for relative As Shot even though canonical XMP omits it', async () => {
    const service = TestBed.inject(SelfHostedBatchSyncService);
    const source = defaultAdjustmentModel();
    const run = service.apply(['a'], buildGroupPatch(source, ['white_balance']), {
      source,
      groups: ['white_balance'],
      relativeWhiteBalance: true,
      sourceBaseline: { temperature: 5000, tint: -1 },
    });
    await settle();
    const create = http.expectOne('/api/jobs');
    expect(create.request.body.payload.relativeWhiteBalance).toEqual({ temperature: 0, tint: 0 });
    expect(create.request.body.payload.patch.attributes['papp:WbScaleVersion']).toBe('5');
    create.flush({ id: 'relative-as-shot' });
    await settle();
    http.expectOne('/api/jobs/relative-as-shot?summary=1').flush(view('done', ['a']));
    expect((await run)?.applied).toEqual(['a']);
  });

  it('queues only selected fields, persists its pointer and summarizes without touching the editor writer', async () => {
    const service = TestBed.inject(SelfHostedBatchSyncService);
    const run = service.apply(['a', 'b'], { exposure: 1.25 });
    await settle();
    const create = http.expectOne('/api/jobs');
    expect(create.request.body.payload.patch).toEqual({
      attributes: { 'crs:Exposure2012': '1.25' },
      elements: {},
    });
    expect(create.request.body.payload.targets).toEqual([
      { id: 'a', path: '/photos/a.jpg' },
      { id: 'b', path: '/photos/b.jpg' },
    ]);
    create.flush({ id: 'saved' });
    await settle();
    expect(localStorage.getItem(key)).toBe('saved');
    http.expectOne('/api/jobs/saved?summary=1').flush(view('done', ['a', 'b']));
    expect((await run)?.applied).toEqual(['a', 'b']);
    expect(invalidate.mock.calls).toEqual([['a'], ['b']]);
    expect(readPersisted).not.toHaveBeenCalled();
    expect(service.progress()).toBeNull();
  });

  it('recovers an interrupted job after reload and resumes its stored target list and patch', async () => {
    localStorage.setItem(key, 'saved');
    const service = TestBed.inject(SelfHostedBatchSyncService);
    await settle();
    http.expectOne('/api/jobs/saved?summary=1').flush(view('cancelled', ['a'], [], ['b']));
    await settle();
    expect(service.remaining()).toEqual(['b']);
    const resumed = service.resume();
    http.expectOne('/api/jobs/saved/resume').flush({ id: 'saved' });
    await settle();
    http.expectOne('/api/jobs/saved?summary=1').flush(view('done', ['a', 'b']));
    expect((await resumed)?.applied).toEqual(['a', 'b']);
    expect(service.remaining()).toEqual([]);
  });

  it('remembers cancel requested before the creation response and sends it to the new job', async () => {
    const service = TestBed.inject(SelfHostedBatchSyncService);
    const run = service.apply(['a'], { exposure: 1 });
    service.cancel();
    await settle();
    http.expectOne('/api/jobs').flush({ id: 'new' });
    await settle();
    http.expectOne('/api/jobs/new/cancel').flush({ ok: true });
    await settle();
    http.expectOne('/api/jobs/new?summary=1').flush(view('cancelled', [], [], ['a']));
    expect((await run)?.cancelled).toBe(true);
  });

  it('can recover creation when the response is lost because the identity was saved before POST', async () => {
    const service = TestBed.inject(SelfHostedBatchSyncService);
    const run = service.apply(['a'], { exposure: 1 });
    await settle();
    const create = http.expectOne('/api/jobs');
    const id = create.request.body.requestId;
    expect(id).toMatch(/^[a-f0-9]{24}$/);
    expect(localStorage.getItem(key)).toBe(id);
    create.flush('response lost', { status: 503, statusText: 'Unavailable' });
    await run;
    expect(service.needsReconnect()).toBe(true);
    const recovered = service.reconnect();
    await settle();
    http.expectOne(`/api/jobs/${id}?summary=1`).flush(view('done', ['a']));
    expect((await recovered)?.applied).toEqual(['a']);
  });

  it('keeps a recovery pointer on connection loss, refuses overlap and reconnects without enqueueing twice', async () => {
    localStorage.setItem(key, 'saved');
    const service = TestBed.inject(SelfHostedBatchSyncService);
    await settle();
    http
      .expectOne('/api/jobs/saved?summary=1')
      .flush('offline', { status: 503, statusText: 'Unavailable' });
    await settle();
    expect(service.needsReconnect()).toBe(true);
    expect(await service.apply(['x'], { exposure: 2 })).toBeNull();
    const recovered = service.reconnect();
    await settle();
    http.expectOne('/api/jobs/saved?summary=1').flush(view('done', ['a']));
    expect((await recovered)?.applied).toEqual(['a']);
  });

  it('retries the saved failure set after reload without requiring the old clipboard patch', async () => {
    localStorage.setItem(key, 'saved');
    const service = TestBed.inject(SelfHostedBatchSyncService);
    await settle();
    http
      .expectOne('/api/jobs/saved?summary=1')
      .flush(view('done', ['a'], [{ id: 'b', reason: 'Disk full' }]));
    await settle();
    const run = service.retryFailed();
    http.expectOne('/api/jobs/saved/retry-failed').flush({ id: 'retry' });
    await settle();
    http.expectOne('/api/jobs/retry?summary=1').flush(view('done', ['b']));
    expect((await run)?.applied).toEqual(['b']);
    expect(localStorage.getItem(key)).toBe('retry');
  });

  it('restores the previous recovery pointer after a rejected retry identity', async () => {
    localStorage.setItem(key, 'saved');
    const service = TestBed.inject(SelfHostedBatchSyncService);
    await settle();
    http
      .expectOne('/api/jobs/saved?summary=1')
      .flush(view('done', ['a'], [{ id: 'b', reason: 'Disk full' }]));
    await settle();
    const previous = service.lastSummary();
    const run = service.retryFailed();
    http
      .expectOne('/api/jobs/saved/retry-failed')
      .flush(
        { error: 'The request id already belongs to a different job' },
        { status: 409, statusText: 'Conflict' },
      );
    await run;
    expect(localStorage.getItem(key)).toBe('saved');
    expect(service.lastSummary()).toEqual(previous);
    expect(service.needsReconnect()).toBe(false);
    expect(service.error()).toContain('different job');
  });

  it('does not overwrite a local edit made while the server job was running', async () => {
    models.set(new Map([['a', defaultAdjustmentModel()]]));
    const service = TestBed.inject(SelfHostedBatchSyncService);
    const run = service.apply(['a'], { exposure: 1 });
    await settle();
    http.expectOne('/api/jobs').flush({ id: 'saved' });
    await settle();
    models.set(new Map([['a', { ...defaultAdjustmentModel(), exposure: 2 }]]));
    http.expectOne('/api/jobs/saved?summary=1').flush(view('done', ['a']));
    await run;
    expect(merge).not.toHaveBeenCalled();
  });
});
