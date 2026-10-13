import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { API_BASE_URL } from '../api/api-base-url.token';
import type { PanoJobView, PanoStitchRequest } from '../api/pano.service';
import { PanoPreviewStore, PREVIEW_DEBOUNCE_MS, PREVIEW_POLL_MS } from './pano-preview.store';
import { panoProgressLabel } from './pano-progress';

const REQUEST: PanoStitchRequest = {
  assetPaths: ['/lib/a.dng', '/lib/b.dng'],
  libraryId: 'lib1',
  options: { retention: 'keep', localAlign: 'mesh' },
};

function job(id: string, patch: Partial<PanoJobView>): PanoJobView {
  return {
    id,
    kind: 'pano_preview',
    status: 'running',
    progress: { current: 0, total: 600 },
    result: null,
    error: null,
    cancel_requested: false,
    created_at: '',
    updated_at: '',
    ...patch,
  };
}

describe('PanoPreviewStore', () => {
  let store: PanoPreviewStore;
  let http: HttpTestingController;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:preview');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        PanoPreviewStore,
        { provide: API_BASE_URL, useValue: '/api' },
      ],
    });
    store = TestBed.inject(PanoPreviewStore);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    TestBed.resetTestingModule();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function startPreview(id: string): void {
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    http.expectOne('/api/pano/preview').flush({ id }, { status: 201, statusText: 'Created' });
    vi.advanceTimersByTime(0);
  }

  function finish(id: string): void {
    vi.advanceTimersByTime(PREVIEW_POLL_MS);
    http.expectOne(`/api/pano/jobs/${id}`).flush(
      job(id, {
        status: 'done',
        progress: { current: 600, total: 600 },
        result: {
          alignment: { status: 'solved', stale_reason: null },
          width: 2047,
          height: 722,
          seconds: 105,
        } as PanoJobView['result'],
      }),
    );
    http.expectOne(`/api/pano/jobs/${id}/preview`).flush(new Blob([new Uint8Array([1])]));
  }

  it('debounces bursts of option changes into one preview job', () => {
    store.request(REQUEST);
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS / 2);
    store.request({ ...REQUEST, options: { retention: 'strict', localAlign: 'mesh' } });
    expect(store.run().kind).toBe('running');
    http.expectNone('/api/pano/preview');
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    const call = http.expectOne('/api/pano/preview');
    expect(call.request.body.options.retention).toBe('strict');
    call.flush({ id: 'p1' }, { status: 201, statusText: 'Created' });
    vi.advanceTimersByTime(0);
    http.expectOne('/api/pano/jobs/p1').flush(job('p1', {}));
  });

  it('reports the job progress while running, then shows the image', () => {
    store.request(REQUEST);
    startPreview('p1');
    http
      .expectOne('/api/pano/jobs/p1')
      .flush(job('p1', { progress: { current: 250, total: 600 } }));
    const run = store.run();
    expect(run.kind === 'running' && panoProgressLabel(run.progress)).toBe('Matching frames · 42%');

    finish('p1');

    expect(store.run().kind).toBe('idle');
    expect(store.image()).toEqual({
      jobId: 'p1',
      url: 'blob:preview',
      result: {
        alignment: { status: 'solved', stale_reason: null },
        width: 2047,
        height: 722,
        seconds: 105,
      },
    });
    expect(store.alignmentFrom()).toBe('p1');
  });

  it('starts a re-preview from the previous preview alignment', () => {
    store.request(REQUEST);
    startPreview('p1');
    http.expectOne('/api/pano/jobs/p1').flush(job('p1', {}));
    finish('p1');

    store.request({ ...REQUEST, options: { retention: 'keep', localAlign: 'off' } });
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    const call = http.expectOne('/api/pano/preview');
    expect(call.request.body.alignmentFrom).toBe('p1');
    call.flush({ id: 'p2' }, { status: 201, statusText: 'Created' });
    vi.advanceTimersByTime(0);
    http.expectOne('/api/pano/jobs/p2').flush(job('p2', {}));
    expect(store.image()?.jobId).toBe('p1');
  });

  it('surfaces a failed job without dropping the last good image', () => {
    store.request(REQUEST);
    startPreview('p1');
    http.expectOne('/api/pano/jobs/p1').flush(job('p1', {}));
    finish('p1');

    store.request(REQUEST);
    startPreview('p2');
    http
      .expectOne('/api/pano/jobs/p2')
      .flush(job('p2', { status: 'failed', error: 'maple-cli exited 1' }));

    expect(store.run()).toEqual({ kind: 'failed', message: 'maple-cli exited 1' });
    expect(store.image()?.jobId).toBe('p1');
  });

  it('explains a 409 while a full stitch is running', () => {
    store.request(REQUEST);
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    http
      .expectOne('/api/pano/preview')
      .flush(
        { error: 'pano_job_running', message: 'busy', jobId: 'j' },
        { status: 409, statusText: 'Conflict' },
      );
    const run = store.run();
    expect(run.kind === 'failed' && run.message).toContain('being stitched');
  });

  it('cancels the in-flight server job and releases the image on dispose', () => {
    store.request(REQUEST);
    startPreview('p1');
    http.expectOne('/api/pano/jobs/p1').flush(job('p1', {}));
    finish('p1');
    store.request(REQUEST);
    startPreview('p2');
    http.expectOne('/api/pano/jobs/p2').flush(job('p2', {}));

    store.dispose();

    const cancel = http.expectOne('/api/pano/jobs/p2');
    expect(cancel.request.method).toBe('DELETE');
    cancel.flush({ ok: true });
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview');
    expect(store.image()).toBeNull();
    expect(store.run().kind).toBe('idle');
    vi.advanceTimersByTime(PREVIEW_POLL_MS * 3);
  });
});
