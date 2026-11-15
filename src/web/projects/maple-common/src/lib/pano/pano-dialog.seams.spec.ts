import { signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PanoDialogComponent } from './pano-dialog.component';
import { PanoPreviewStore } from './pano-preview.store';
import { API_BASE_URL } from '../api/api-base-url.token';
import { LibraryStateService } from '../state/library-state.service';
import type { PanoConfig, PanoPreviewResult, SeamConstraintsRequest } from '../api/pano.service';

const constraints: SeamConstraintsRequest = {
  version: 1,
  canvas: { width: 1000, height: 400 },
  regions: [{ kind: 'include', frame: 1, x: 20, y: 30, width: 40, height: 50 }],
};

const config: PanoConfig = {
  maple_cli_path: '/opt/maple-cli',
  models_dir: null,
  ort_dylib_path: null,
  enabled: true,
  matcher: 'classical',
  strategy_supported: true,
  features_engine_supported: true,
  preview_supported: true,
  edges_supported: true,
  seamConstraintsSupported: true,
  source: {
    maple_cli_path: 'db',
    models_dir: 'unset',
    ort_dylib_path: 'unset',
    enabled: 'db',
    matcher: 'db',
  },
};

describe('panorama dialog seam constraints', () => {
  let fixture: ComponentFixture<PanoDialogComponent>;
  let http: HttpTestingController;
  const image = signal<{ jobId: string; url: string; result: PanoPreviewResult | null } | null>(
    null,
  );
  const run = signal<
    { kind: 'idle' } | { kind: 'running'; progress: null } | { kind: 'failed'; message: string }
  >({ kind: 'idle' });
  const preview = {
    image,
    run,
    request: vi.fn(),
    cancel: vi.fn(),
    dispose: vi.fn(),
    alignmentFrom: () => image()?.jobId ?? null,
  };

  beforeEach(() => {
    image.set(null);
    run.set({ kind: 'idle' });
    vi.clearAllMocks();
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
            currentRegisteredFolder: () => ({ id: 'library' }),
            absPathFor: (id: string) => `/photos/${id}.dng`,
            apiIdFor: () => undefined,
          },
        },
      ],
    }).overrideComponent(PanoDialogComponent, {
      set: { providers: [{ provide: PanoPreviewStore, useValue: preview }] },
    });
    fixture = TestBed.createComponent(PanoDialogComponent);
    http = TestBed.inject(HttpTestingController);
    fixture.componentRef.setInput('assetIds', ['z', 'a']);
    fixture.componentRef.setInput('visible', true);
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
    for (const call of http.match((request) => request.method === 'DELETE'))
      call.flush({ ok: true });
    http.verify();
    TestBed.resetTestingModule();
  });

  function open(supported = true): void {
    http.expectOne('/api/pano/config').flush({ ...config, seamConstraintsSupported: supported });
    fixture.detectChanges();
    image.set({
      jobId: 'preview-1',
      url: 'blob:preview',
      result: {
        alignment: null,
        width: 1000,
        height: 400,
        seconds: 1,
        frames: [
          { assetId: 'first', path: '/photos/a.dng' },
          { assetId: 'second', path: '/photos/z.dng' },
        ],
      },
    });
    fixture.detectChanges();
  }

  it('keeps constraints out of automatic previews and sends them top-level with alignment reuse', () => {
    open();
    const dialog = fixture.componentInstance;
    const count = preview.request.mock.calls.length;
    dialog.seamConstraints.set(constraints);
    fixture.detectChanges();
    expect(preview.request).toHaveBeenCalledTimes(count);
    expect(preview.request.mock.calls[0][0]).not.toHaveProperty('seamConstraints');
    dialog.onPreviewSeams();
    expect(preview.request).toHaveBeenLastCalledWith(
      expect.objectContaining({ seamConstraints: constraints }),
    );
    dialog.onSubmit();
    const call = http.expectOne('/api/pano/stitch');
    expect(call.request.body).toMatchObject({
      seamConstraints: constraints,
      alignmentFrom: 'preview-1',
    });
    expect(call.request.body.options).not.toHaveProperty('seamConstraints');
    call.flush({ id: 'stitch-1' });
  });

  it('clears regions and disables stale geometry until a new preview arrives', () => {
    open();
    const dialog = fixture.componentInstance;
    dialog.seamConstraints.set(constraints);
    dialog.committedWarp.set(20);
    dialog.boundaryWarp.set(20);
    fixture.detectChanges();
    expect(dialog.seamConstraints()).toBeNull();
    expect(dialog.seamDisabledReason()).toContain('Wait');
    image.set({ ...image()!, jobId: 'preview-2' });
    fixture.detectChanges();
    expect(dialog.seamDisabledReason()).toBeNull();
    dialog.seamConstraints.set(constraints);
    dialog.strategy.set('tile');
    fixture.detectChanges();
    expect(dialog.seamConstraints()).toBeNull();
    expect(dialog.seamDisabledReason()).toContain('Choose Rotation');
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('not supported for Tile');
  });

  it.each(['invalid_seam_constraints', 'pano_job_running'])(
    'allows correcting and resubmitting regions after a %s preview failure',
    (message) => {
      open();
      const dialog = fixture.componentInstance;
      dialog.seamConstraints.set(constraints);
      dialog.onPreviewSeams();
      run.set({ kind: 'running', progress: null });
      fixture.detectChanges();
      expect(dialog.seamDisabledReason()).toContain('Wait');
      run.set({ kind: 'failed', message });
      fixture.detectChanges();
      expect(dialog.seamDisabledReason()).toBeNull();
      expect(image()?.jobId).toBe('preview-1');
      const corrected: SeamConstraintsRequest = {
        ...constraints,
        regions: [{ ...constraints.regions[0], width: 20 }],
      };
      dialog.seamConstraints.set(corrected);
      dialog.onPreviewSeams();
      expect(preview.request).toHaveBeenLastCalledWith(
        expect.objectContaining({ seamConstraints: corrected }),
      );
      dialog.onSubmit();
      const call = http.expectOne('/api/pano/stitch');
      expect(call.request.body.seamConstraints).toEqual(corrected);
      call.flush({ id: 'corrected-stitch' });
    },
  );

  it('keeps stale geometry disabled when its replacement preview fails', () => {
    open();
    const dialog = fixture.componentInstance;
    dialog.localAlign.set('off');
    fixture.detectChanges();
    run.set({ kind: 'failed', message: 'replacement failed' });
    fixture.detectChanges();
    expect(dialog.seamDisabledReason()).toContain('Wait');
  });

  it('does not offer authoring with an unsupported binary', () => {
    open(false);
    expect((fixture.nativeElement as HTMLElement).querySelector('app-pano-seam-editor')).toBeNull();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain(
      'requires a server panorama binary',
    );
    fixture.componentInstance.seamConstraints.set(constraints);
    fixture.componentInstance.onSubmit();
    http.expectNone('/api/pano/stitch');
  });
});
