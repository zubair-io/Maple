import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { PanoDialogComponent } from './pano-dialog.component';
import { API_BASE_URL } from '../api/api-base-url.token';
import { LibraryStateService } from '../state/library-state.service';
import type { PanoConfig } from '../api/pano.service';

const config = (strategySupported: boolean): PanoConfig => ({
  maple_cli_path: '/opt/maple-cli',
  models_dir: '/models',
  ort_dylib_path: null,
  enabled: true,
  matcher: 'classical',
  strategy_supported: strategySupported,
  features_engine_supported: true,
  preview_supported: false,
  edges_supported: false,
  source: {
    maple_cli_path: 'db',
    models_dir: 'db',
    ort_dylib_path: 'unset',
    enabled: 'db',
    matcher: 'default',
  },
});

describe('PanoDialogComponent going away mid-submit and between opens (#5517)', () => {
  let fixture: ComponentFixture<PanoDialogComponent>;
  let http: HttpTestingController;

  beforeEach(() => {
    vi.useFakeTimers();
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
  });

  function open(strategySupported: boolean): void {
    fixture.componentRef.setInput('visible', true);
    fixture.detectChanges();
    http.expectOne('/api/pano/config').flush(config(strategySupported));
    fixture.detectChanges();
  }

  it('cancels a job whose stitch response lands after the dialog was hidden', () => {
    open(false);
    fixture.componentInstance.onSubmit();
    const stitch = http.expectOne('/api/pano/stitch');
    expect(fixture.componentInstance.phase()).toBe('submitting');

    fixture.componentRef.setInput('visible', false);
    fixture.detectChanges();
    stitch.flush({ id: 'j-orphan' }, { status: 201, statusText: 'Created' });

    const cancel = http.expectOne('/api/pano/jobs/j-orphan');
    expect(cancel.request.method).toBe('DELETE');
    cancel.flush({ ok: true });
    expect(fixture.componentInstance.phase()).toBe('idle');
    vi.advanceTimersByTime(6_000);
    http.expectNone('/api/pano/jobs/j-orphan');
  });

  it('cancels a job whose stitch response lands after the dialog was destroyed', () => {
    open(false);
    fixture.componentInstance.onSubmit();
    const stitch = http.expectOne('/api/pano/stitch');

    fixture.destroy();
    stitch.flush({ id: 'j-gone' }, { status: 201, statusText: 'Created' });

    http.expectOne({ method: 'DELETE', url: '/api/pano/jobs/j-gone' }).flush({ ok: true });
    vi.advanceTimersByTime(6_000);
    http.expectNone('/api/pano/jobs/j-gone');
  });

  it('ignores a stitch rejection that lands after the dialog was hidden', () => {
    open(false);
    fixture.componentInstance.onSubmit();
    const stitch = http.expectOne('/api/pano/stitch');
    fixture.componentRef.setInput('visible', false);
    fixture.detectChanges();
    stitch.flush(
      { error: 'pano_job_running', message: 'busy' },
      { status: 409, statusText: 'Conflict' },
    );
    expect(fixture.componentInstance.phase()).toBe('idle');
    expect(fixture.componentInstance.errorMessage()).toBe('');
  });

  it('starts every open from the default options', () => {
    open(true);
    const dialog = fixture.componentInstance;
    dialog.retention.set('strict');
    dialog.localAlign.set('off');
    dialog.strategy.set('tile');

    dialog.onCancel();
    fixture.componentRef.setInput('visible', false);
    fixture.detectChanges();
    open(true);

    expect(dialog.retention()).toBe('keep');
    expect(dialog.localAlign()).toBe('mesh');
    expect(dialog.strategy()).toBe('auto');
    const strategySelect = (fixture.nativeElement as HTMLElement).querySelector<HTMLSelectElement>(
      '#pano-strategy',
    );
    expect(strategySelect?.value).toBe('auto');
  });

  it('announces the imported panorama once the job finishes', () => {
    let created = 0;
    fixture.componentInstance.created.subscribe(() => (created += 1));
    open(false);
    fixture.componentInstance.onSubmit();
    http.expectOne('/api/pano/stitch').flush({ id: 'j1' }, { status: 201, statusText: 'Created' });

    vi.advanceTimersByTime(2_000);
    http
      .expectOne('/api/pano/jobs/j1')
      .flush({ id: 'j1', status: 'running', progress: null, result: null, error: null });
    expect(created).toBe(0);

    vi.advanceTimersByTime(2_000);
    http.expectOne('/api/pano/jobs/j1').flush({
      id: 'j1',
      status: 'done',
      progress: null,
      result: { outputAssetId: 'pano-asset' },
      error: null,
    });
    expect(fixture.componentInstance.phase()).toBe('done');
    expect(created).toBe(1);
  });
});
