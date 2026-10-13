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

  it('cancels a job whose id arrives after the dialog cancelled the preview', () => {
    store.request(REQUEST);
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    const pending = http.expectOne('/api/pano/preview');

    store.cancel();
    pending.flush({ id: 'late' }, { status: 201, statusText: 'Created' });
    vi.advanceTimersByTime(0);

    const cancel = http.expectOne('/api/pano/jobs/late');
    expect(cancel.request.method).toBe('DELETE');
    cancel.flush({ ok: true });
    vi.advanceTimersByTime(PREVIEW_POLL_MS * 3);
    expect(store.run().kind).toBe('idle');
  });

  it('cancels a job whose id arrives after the store was disposed', () => {
    store.request(REQUEST);
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    const pending = http.expectOne('/api/pano/preview');

    store.dispose();
    pending.flush({ id: 'late' }, { status: 201, statusText: 'Created' });
    vi.advanceTimersByTime(0);

    expect(http.expectOne('/api/pano/jobs/late').request.method).toBe('DELETE');
    vi.advanceTimersByTime(PREVIEW_POLL_MS * 3);
  });

  it('cancels a superseded preview whose id arrives after a newer request', () => {
    store.request(REQUEST);
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    const first = http.expectOne('/api/pano/preview');

    store.request(REQUEST);
    first.flush({ id: 'old' }, { status: 201, statusText: 'Created' });
    vi.advanceTimersByTime(0);
    expect(http.expectOne('/api/pano/jobs/old').request.method).toBe('DELETE');

    startPreview('new');
    http.expectOne('/api/pano/jobs/new').flush(job('new', { status: 'cancelled' }));
  });

  it('stops polling as soon as the preview is cancelled', () => {
    store.request(REQUEST);
    startPreview('p1');
    http.expectOne('/api/pano/jobs/p1').flush(job('p1', {}));

    store.cancel();
    http.expectOne('/api/pano/jobs/p1').flush({ ok: true });
    vi.advanceTimersByTime(PREVIEW_POLL_MS * 3);
    http.expectNone('/api/pano/jobs/p1');
  });

  it('serializes preview creation so a newer request waits for an in-flight POST to finish', () => {
    store.request(REQUEST);
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    const first = http.expectOne('/api/pano/preview');

    // Newer request arrives and its debounce expires while first POST is still in flight:
    store.request(REQUEST);
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);

    // The second POST must NOT be sent yet (preventing reordering on the server):
    http.expectNone('/api/pano/preview');

    // First POST returns:
    first.flush({ id: 'old' }, { status: 201, statusText: 'Created' });
    vi.advanceTimersByTime(0);

    // Old job is deleted:
    expect(http.expectOne('/api/pano/jobs/old').request.method).toBe('DELETE');

    // Now the second POST is emitted:
    const second = http.expectOne('/api/pano/preview');
    second.flush({ id: 'new' }, { status: 201, statusText: 'Created' });
    vi.advanceTimersByTime(0);

    // Second job is polled:
    http.expectOne('/api/pano/jobs/new').flush(job('new', {}));
    expect(store.run().kind).toBe('running');
  });

  it('does not send a queued preview POST if cancelled while waiting for an in-flight POST', () => {
    store.request(REQUEST);
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    const first = http.expectOne('/api/pano/preview');

    store.request(REQUEST);
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    http.expectNone('/api/pano/preview');

    // User cancels while waiting:
    store.cancel();

    // First POST finishes:
    first.flush({ id: 'old' }, { status: 201, statusText: 'Created' });
    vi.advanceTimersByTime(0);
    expect(http.expectOne('/api/pano/jobs/old').request.method).toBe('DELETE');

    // Second POST is never emitted:
    http.expectNone('/api/pano/preview');
    expect(store.run().kind).toBe('idle');
  });

  it('allows the newer request to proceed if the older in-flight POST fails', () => {
    store.request(REQUEST);
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    const first = http.expectOne('/api/pano/preview');

    store.request(REQUEST);
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);

    first.flush('error', { status: 500, statusText: 'Server Error' });
    vi.advanceTimersByTime(0);

    const second = http.expectOne('/api/pano/preview');
    second.flush({ id: 'new' }, { status: 201, statusText: 'Created' });
    vi.advanceTimersByTime(0);
    http.expectOne('/api/pano/jobs/new').flush(job('new', {}));
    expect(store.run().kind).toBe('running');
  });
});
