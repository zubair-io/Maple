import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { PanoDialogComponent } from './pano-dialog.component';
import { API_BASE_URL } from '../api/api-base-url.token';
import { LibraryStateService } from '../state/library-state.service';
import type { PanoConfig, PanoEdgesReport, PanoJobView } from '../api/pano.service';
import { PREVIEW_DEBOUNCE_MS, PREVIEW_POLL_MS } from './pano-preview.store';

const config = (previewSupported: boolean, edgesSupported: boolean): PanoConfig => ({
  maple_cli_path: '/opt/maple-cli',
  models_dir: '/models',
  ort_dylib_path: null,
  enabled: true,
  matcher: 'classical',
  strategy_supported: false,
  features_engine_supported: true,
  preview_supported: previewSupported,
  edges_supported: edgesSupported,
  source: {
    maple_cli_path: 'db',
    models_dir: 'db',
    ort_dylib_path: 'unset',
    enabled: 'db',
    matcher: 'default',
  },
});

const edgesReport = (
  requested: number,
  status: string,
  applied = requested,
  autoCrop = false,
): PanoEdgesReport => ({
  output: { width: 2047, height: 722 },
  uncovered_px: 0,
  boundary_warp: {
    requested,
    applied,
    status,
    max_stretch: null,
    min_jacobian: null,
    predicted_coverage: null,
    solve_ms: null,
  },
  auto_crop: { requested: autoCrop, rect: null, invalid_px: null },
});

const job = (id: string, patch: Partial<PanoJobView>): PanoJobView => ({
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

describe('PanoDialogComponent Edges group (#5576)', () => {
  let fixture: ComponentFixture<PanoDialogComponent>;
  let http: HttpTestingController;
  let root: HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:preview');
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
    root = fixture.nativeElement;
  });

  afterEach(() => {
    http.verify();
    TestBed.resetTestingModule();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const byId = (id: string) => root.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  const slider = () => byId('pano-boundary-warp')!.querySelector('input') as HTMLInputElement;
  const toggle = () => byId('pano-auto-crop')!.querySelector('button') as HTMLButtonElement;

  function open(previewSupported: boolean, edgesSupported: boolean): void {
    fixture.componentRef.setInput('visible', true);
    fixture.detectChanges();
    http.expectOne('/api/pano/config').flush(config(previewSupported, edgesSupported));
    fixture.detectChanges();
  }

  function previewCreated(id: string) {
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    const call = http.expectOne('/api/pano/preview');
    call.flush({ id }, { status: 201, statusText: 'Created' });
    vi.advanceTimersByTime(0);
    return call.request.body;
  }

  function previewDone(id: string, edges: PanoEdgesReport | null = null): void {
    http.expectOne(`/api/pano/jobs/${id}`).flush(job(id, {}));
    vi.advanceTimersByTime(PREVIEW_POLL_MS);
    http.expectOne(`/api/pano/jobs/${id}`).flush(
      job(id, {
        status: 'done',
        progress: { current: 600, total: 600 },
        result: {
          alignment: null,
          edges,
          width: 2047,
          height: 722,
          seconds: 1,
        } as PanoJobView['result'],
      }),
    );
    http.expectOne(`/api/pano/jobs/${id}/preview`).flush(new Blob([new Uint8Array([1])]));
    fixture.detectChanges();
  }

  function drag(value: string): void {
    slider().value = value;
    slider().dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }

  function release(): void {
    slider().dispatchEvent(new Event('change'));
    fixture.detectChanges();
  }

  it('hides the group when the binary has no edge options', () => {
    open(true, false);
    previewCreated('p1');
    expect(byId('pano-boundary-warp')).toBeNull();
    expect(byId('pano-auto-crop')).toBeNull();
    http.expectOne('/api/pano/jobs/p1').flush(job('p1', {}));
    fixture.componentInstance.onCancel();
    http.expectOne({ method: 'DELETE', url: '/api/pano/jobs/p1' }).flush({ ok: true });
  });

  it('shows Boundary Warp at 0% with the muted help, and Auto Crop off, after the preview and before retention', () => {
    open(true, true);
    previewCreated('p1');
    expect(byId('pano-boundary-warp')!.textContent).toContain('Boundary Warp');
    expect(byId('pano-boundary-warp')!.textContent).toContain('0%');
    expect(byId('pano-boundary-warp')!.textContent).toContain(
      'Stretches the edges toward a full rectangle.',
    );
    expect(byId('pano-boundary-warp-reason')).toBeNull();
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    const order = [
      ...root.querySelectorAll('[data-testid="pano-preview"], #pano-retention, mui-panorama-edges'),
    ];
    expect(order.map((el) => el.tagName.toLowerCase())).toEqual([
      'div',
      'select',
      'mui-panorama-edges',
    ]);
    http.expectOne('/api/pano/jobs/p1').flush(job('p1', {}));
    fixture.componentInstance.onCancel();
    http.expectOne({ method: 'DELETE', url: '/api/pano/jobs/p1' }).flush({ ok: true });
  });

  it('sends nothing new at the defaults', () => {
    open(true, true);
    const body = previewCreated('p1');
    expect(body.options).toEqual({ retention: 'keep', localAlign: 'mesh' });
    previewDone('p1');
    fixture.componentInstance.onSubmit();
    expect(http.expectOne('/api/pano/stitch').request.body.options).toEqual({
      retention: 'keep',
      localAlign: 'mesh',
    });
  });

  it('re-previews once when a drag ends, not on every step, from the same alignment', () => {
    open(true, true);
    previewCreated('p1');
    previewDone('p1');
    drag('10');
    drag('25');
    drag('40');
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS * 2);
    http.expectNone('/api/pano/preview');
    expect(byId('pano-boundary-warp')!.textContent).toContain('40%');

    release();
    const body = previewCreated('p2');
    expect(body.options.boundaryWarp).toBe(40);
    expect(body.alignmentFrom).toBe('p1');
    http.expectOne('/api/pano/jobs/p2').flush(job('p2', {}));
    fixture.componentInstance.onCancel();
    http.expectOne({ method: 'DELETE', url: '/api/pano/jobs/p2' }).flush({ ok: true });
  });

  it('re-previews immediately when Auto Crop changes, and sends it with the stitch', () => {
    open(true, true);
    previewCreated('p1');
    previewDone('p1');
    toggle().click();
    fixture.detectChanges();
    const body = previewCreated('p2');
    expect(body.options.autoCrop).toBe(true);
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    previewDone('p2', edgesReport(0, 'off', 0, true));
    fixture.componentInstance.onSubmit();
    expect(http.expectOne('/api/pano/stitch').request.body.options).toEqual({
      retention: 'keep',
      localAlign: 'mesh',
      autoCrop: true,
    });
  });

  it('says why the warp was limited, keeps the requested value, and drops the reason at 0%', () => {
    open(true, true);
    previewCreated('p1');
    previewDone('p1');
    drag('60');
    release();
    previewCreated('p2');
    previewDone('p2', edgesReport(60, 'clamped_fold', 37.4));

    expect(byId('pano-boundary-warp-reason')!.textContent).toContain(
      "Limited to 37% so the image doesn't fold.",
    );
    expect(byId('pano-boundary-warp')!.textContent).toContain('60%');
    expect(slider().value).toBe('60');

    drag('0');
    release();
    expect(byId('pano-boundary-warp-reason')).toBeNull();
    expect(byId('pano-boundary-warp')!.textContent).toContain(
      'Stretches the edges toward a full rectangle.',
    );
    previewCreated('p3');
    http.expectOne('/api/pano/jobs/p3').flush(job('p3', {}));
    fixture.componentInstance.onCancel();
    http.expectOne({ method: 'DELETE', url: '/api/pano/jobs/p3' }).flush({ ok: true });
  });

  it('keeps the old reason and shows "Updating edges…" over a dimmed preview until the new report arrives', () => {
    open(true, true);
    previewCreated('p1');
    previewDone('p1');
    drag('60');
    release();
    previewCreated('p2');
    previewDone('p2', edgesReport(60, 'refused_fold', 0));
    expect(byId('pano-boundary-warp-reason')!.textContent).toContain('would fold the image');

    drag('80');
    release();
    previewCreated('p3');
    http.expectOne('/api/pano/jobs/p3').flush(job('p3', {}));
    fixture.detectChanges();
    expect(root.textContent).toContain('Updating edges…');
    expect(root.querySelector('img[alt="Panorama preview"]')!.className).toContain('opacity-50');
    expect(byId('pano-boundary-warp-reason')!.textContent).toContain('would fold the image');
    expect(slider().disabled).toBe(false);
    expect(toggle().disabled).toBe(false);

    vi.advanceTimersByTime(PREVIEW_POLL_MS);
    http.expectOne('/api/pano/jobs/p3').flush(
      job('p3', {
        status: 'done',
        result: {
          alignment: null,
          edges: edgesReport(80, 'refused_disconnected', 0),
        } as PanoJobView['result'],
      }),
    );
    http.expectOne('/api/pano/jobs/p3/preview').flush(new Blob([new Uint8Array([1])]));
    fixture.detectChanges();
    expect(root.textContent).not.toContain('Updating edges…');
    expect(byId('pano-boundary-warp-reason')!.textContent).toContain('separate pieces');
  });

  it('shows no reason for a status it does not know', () => {
    open(true, true);
    previewCreated('p1');
    previewDone('p1');
    drag('50');
    release();
    previewCreated('p2');
    previewDone('p2', edgesReport(50, 'refused_from_the_future', 0));
    expect(byId('pano-boundary-warp-reason')).toBeNull();
    expect(byId('pano-boundary-warp')!.textContent).toContain('Stretches the edges');
  });

  it('without a preview, reports the reason in the done state after the stitch', () => {
    open(false, true);
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS * 2);
    http.expectNone('/api/pano/preview');
    drag('70');
    release();
    fixture.componentInstance.onSubmit();
    const stitch = http.expectOne('/api/pano/stitch');
    expect(stitch.request.body.options.boundaryWarp).toBe(70);
    stitch.flush({ id: 's1' }, { status: 201, statusText: 'Created' });
    vi.advanceTimersByTime(2_000);
    http.expectOne('/api/pano/jobs/s1').flush({
      ...job('s1', { status: 'done' }),
      kind: 'pano_stitch',
      result: {
        outputAssetId: 'out1',
        outputPath: '/V/p.png',
        stagesCompleted: 6,
        error: null,
        edges: edgesReport(70, 'refused_full_wrap', 0),
      },
    });
    fixture.detectChanges();
    expect(fixture.componentInstance.phase()).toBe('done');
    expect(byId('pano-boundary-warp-reason')!.textContent).toContain('360° panoramas');
  });
});
