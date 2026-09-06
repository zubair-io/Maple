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
