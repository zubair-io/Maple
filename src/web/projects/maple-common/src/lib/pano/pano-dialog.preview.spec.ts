import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { PanoDialogComponent } from './pano-dialog.component';
import { API_BASE_URL } from '../api/api-base-url.token';
import { LibraryStateService } from '../state/library-state.service';
import type { PanoConfig, PanoJobView } from '../api/pano.service';
import { PREVIEW_DEBOUNCE_MS, PREVIEW_POLL_MS } from './pano-preview.store';

const config = (previewSupported: boolean): PanoConfig => ({
  maple_cli_path: '/opt/maple-cli',
  models_dir: '/models',
  ort_dylib_path: null,
  enabled: true,
  matcher: 'classical',
  strategy_supported: false,
  features_engine_supported: true,
  preview_supported: previewSupported,
  source: {
    maple_cli_path: 'db',
    models_dir: 'db',
    ort_dylib_path: 'unset',
    enabled: 'db',
    matcher: 'default',
  },
});

const previewJob = (id: string, patch: Partial<PanoJobView>): PanoJobView => ({
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
});

describe('PanoDialogComponent quick preview (#4580)', () => {
  let fixture: ComponentFixture<PanoDialogComponent>;
  let http: HttpTestingController;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:preview-1');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    TestBed.configureTestingModule({
      imports: [PanoDialogComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: API_BASE_URL, useValue: '/api' },
        {
          provide: LibraryStateService,
          useValue: {
            currentRegisteredFolder: () => ({ id: 'deadbeefdeadbeefdeadbeef', path: '/V' }),
            apiIdFor: () => undefined,
            absPathFor: (id: string) => `/V/${id}.dng`,
          },
        },
      ],
    });
    fixture = TestBed.createComponent(PanoDialogComponent);
    http = TestBed.inject(HttpTestingController);
    fixture.componentRef.setInput('assetIds', ['a1', 'a2']);
  });

  afterEach(() => {
    http.verify();
    TestBed.resetTestingModule();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function open(previewSupported: boolean): void {
    fixture.componentRef.setInput('visible', true);
    fixture.detectChanges();
    http.expectOne('/api/pano/config').flush(config(previewSupported));
    fixture.detectChanges();
  }

  function previewCreated(id: string) {
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    const call = http.expectOne('/api/pano/preview');
    call.flush({ id }, { status: 201, statusText: 'Created' });
    vi.advanceTimersByTime(0);
    return call.request.body;
  }

  function previewDone(id: string, result: PanoJobView['result'] = null): void {
    http.expectOne(`/api/pano/jobs/${id}`).flush(previewJob(id, {}));
    vi.advanceTimersByTime(PREVIEW_POLL_MS);
    http
      .expectOne(`/api/pano/jobs/${id}`)
      .flush(previewJob(id, { status: 'done', progress: { current: 600, total: 600 }, result }));
    http.expectOne(`/api/pano/jobs/${id}/preview`).flush(new Blob([new Uint8Array([1])]));
    fixture.detectChanges();
  }

  it('previews the selection automatically and shows the image', () => {
    open(true);
    const body = previewCreated('p1');
    expect(body).toEqual({
      assetPaths: ['/V/a1.dng', '/V/a2.dng'],
      libraryId: 'deadbeefdeadbeefdeadbeef',
      options: { retention: 'keep', localAlign: 'mesh' },
    });
    previewDone('p1');
    const img = fixture.nativeElement.querySelector('img[alt="Panorama preview"]');
    expect(img?.getAttribute('src')).toBe('blob:preview-1');
  });

  it('shows real stage progress while the preview runs', () => {
    open(true);
    previewCreated('p1');
    http
      .expectOne('/api/pano/jobs/p1')
      .flush(previewJob('p1', { progress: { current: 250, total: 600 } }));
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Preview — Matching frames · 42%');
    expect(fixture.nativeElement.querySelector('[role="progressbar"]')).not.toBeNull();
    fixture.componentInstance.onCancel();
    http.expectOne({ method: 'DELETE', url: '/api/pano/jobs/p1' }).flush({ ok: true });
  });

  it('re-previews from the last alignment when an option changes', () => {
    open(true);
    previewCreated('p1');
    previewDone('p1');
    fixture.componentInstance.localAlign.set('off');
    fixture.detectChanges();
    const body = previewCreated('p2');
    expect(body.options.localAlign).toBe('off');
    expect(body.alignmentFrom).toBe('p1');
    http.expectOne('/api/pano/jobs/p2').flush(previewJob('p2', {}));
    fixture.componentInstance.onCancel();
    http.expectOne({ method: 'DELETE', url: '/api/pano/jobs/p2' }).flush({ ok: true });
  });

  it('"Create panorama" stitches with the preview alignment', () => {
    open(true);
    previewCreated('p1');
    previewDone('p1');
    const button = [...fixture.nativeElement.querySelectorAll('mui-button')].find((b: Element) =>
      b.textContent?.includes('Create panorama'),
    );
    expect(button).toBeDefined();
    fixture.componentInstance.onSubmit();
    const stitch = http.expectOne('/api/pano/stitch');
    expect(stitch.request.body.alignmentFrom).toBe('p1');
    stitch.flush({ id: 's1', alignmentReused: true }, { status: 201, statusText: 'Created' });
    expect(fixture.componentInstance.phase()).toBe('polling');
  });

  it('says which matcher ran when ML fell back to classical (#5487)', () => {
    const matcherNote = 'Used the classical matcher because the models aren’t installed.';
    const fallback = { matcher: 'classical' as const, matcherNote };
    open(true);
    previewCreated('p1');
    previewDone('p1', {
      alignment: null,
      width: 2047,
      height: 722,
      seconds: 1.5,
      ...fallback,
    } as PanoJobView['result']);
    const note = () =>
      fixture.nativeElement.querySelector('[data-testid="pano-matcher-note"]')?.textContent?.trim();
    expect(note()).toBe(matcherNote);

    fixture.componentInstance.onSubmit();
    http.expectOne('/api/pano/stitch').flush({ id: 's1' }, { status: 201, statusText: 'Created' });
    vi.advanceTimersByTime(2_000);
    http.expectOne('/api/pano/jobs/s1').flush({
      ...previewJob('s1', { status: 'done' }),
      kind: 'pano_stitch',
      result: {
        outputAssetId: 'out1',
        outputPath: '/V/.maple/panos/s1.png',
        stagesCompleted: 6,
        error: null,
        ...fallback,
      },
    });
    fixture.detectChanges();
    expect(fixture.componentInstance.phase()).toBe('done');
    expect(fixture.nativeElement.textContent).toContain('Panorama ready.');
    expect(note()).toBe(matcherNote);
  });

  it('cancels an unfinished preview and stitches without an alignment', () => {
    open(true);
    previewCreated('p1');
    http.expectOne('/api/pano/jobs/p1').flush(previewJob('p1', {}));
    fixture.componentInstance.onSubmit();
    http.expectOne({ method: 'DELETE', url: '/api/pano/jobs/p1' }).flush({ ok: true });
    const stitch = http.expectOne('/api/pano/stitch');
    expect(stitch.request.body.alignmentFrom).toBeUndefined();
    stitch.flush({ id: 's1' }, { status: 201, statusText: 'Created' });
  });

  it('skips the preview on a binary without it', () => {
    open(false);
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS * 2);
    http.expectNone('/api/pano/preview');
    expect(fixture.nativeElement.querySelector('[data-testid="pano-preview"]')).toBeNull();
  });
});
