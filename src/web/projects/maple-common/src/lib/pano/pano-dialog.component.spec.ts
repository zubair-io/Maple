import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { PanoDialogComponent } from './pano-dialog.component';
import { API_BASE_URL } from '../api/api-base-url.token';
import { LibraryStateService } from '../state/library-state.service';
import type { PanoConfig } from '../api/pano.service';

const CONFIG = (strategySupported: boolean): PanoConfig => ({
  maple_cli_path: '/opt/maple-cli',
  models_dir: '/models',
  ort_dylib_path: null,
  enabled: true,
  strategy_supported: strategySupported,
  source: {
    maple_cli_path: 'db',
    models_dir: 'db',
    ort_dylib_path: 'unset',
    enabled: 'db',
  },
});

// Minimal ApiFolder stub for the registered-folder mock.
const MOCK_FOLDER = { id: 'deadbeefdeadbeefdeadbeef', path: '/Volumes/Photos', label: 'Photos' };

/**
 * Build a mock LibraryStateService.
 *
 * @param folderOverride - null = no registered folder (simulates "no library selected")
 * @param apiIdMap - local assetId → MongoDB hex _id map (empty = not indexed)
 */
function makeLibraryStateMock(
  folderOverride: typeof MOCK_FOLDER | null = MOCK_FOLDER,
  apiIdMap: Record<string, string> = { a1: 'aaa', a2: 'bbb', a3: 'ccc' },
) {
  return {
    selectedSourceId: () => 'fs:/Volumes/Photos',
    currentRegisteredFolder: () => folderOverride,
    apiIdFor: (id: string) => apiIdMap[id],
  };
}

describe('PanoDialogComponent', () => {
  let fixture: ComponentFixture<PanoDialogComponent>;
  let http: HttpTestingController;

  function setup(
    folderOverride: typeof MOCK_FOLDER | null = MOCK_FOLDER,
    apiIdMap: Record<string, string> = { a1: 'aaa', a2: 'bbb', a3: 'ccc' },
  ): void {
    TestBed.configureTestingModule({
      imports: [PanoDialogComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: API_BASE_URL, useValue: '/api' },
        {
          provide: LibraryStateService,
          useValue: makeLibraryStateMock(folderOverride, apiIdMap),
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(PanoDialogComponent);
    http = TestBed.inject(HttpTestingController);
    fixture.componentRef.setInput('assetIds', ['a1', 'a2', 'a3']);
  }

  beforeEach(() => setup());
  afterEach(() => {
    http.verify();
    TestBed.resetTestingModule();
  });

  function open(strategySupported: boolean): void {
    fixture.componentRef.setInput('visible', true);
    fixture.detectChanges();
    http.expectOne('/api/pano/config').flush(CONFIG(strategySupported));
    fixture.detectChanges();
  }

  it('loads config on open and reaches the options phase', () => {
    open(false);
    expect(fixture.componentInstance.phase()).toBe('options');
    expect(fixture.componentInstance.strategySupported()).toBe(false);
  });

  it('hides the strategy control when the binary does not support it', () => {
    open(false);
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('#pano-strategy')).toBeNull();
  });

  it('shows the strategy control when supported', () => {
    open(true);
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('#pano-strategy')).not.toBeNull();
  });

  // ── LOAD-BEARING: libraryId and assetIds resolution (comments #1 & #2) ──────

  it('submits the folder ObjectId as libraryId and resolved API ids as assetIds', () => {
    // The local asset ids are 'a1', 'a2', 'a3'. The mock maps them to
    // 'aaa', 'bbb', 'ccc'. The library folder id is MOCK_FOLDER.id.
    // The handler expects MongoDB ObjectId hex strings for both fields.
    open(false);
    fixture.componentInstance.onSubmit();
    const call = http.expectOne('/api/pano/stitch');
    expect(call.request.body).toEqual({
      assetIds: ['aaa', 'bbb', 'ccc'],
      libraryId: MOCK_FOLDER.id,
      options: { retention: 'keep', localAlign: 'mesh' },
    });
    call.flush({ id: 'j1' }, { status: 201, statusText: 'Created' });
    expect(fixture.componentInstance.phase()).toBe('polling');
    fixture.componentInstance.onCancel();
  });

  it('shows an error when no registered library is selected (comment #1)', () => {
    // Re-create the component with no registered folder.
    TestBed.resetTestingModule();
    setup(null);
    open(false);
    fixture.componentInstance.onSubmit();
    expect(fixture.componentInstance.phase()).toBe('error');
    expect(fixture.componentInstance.errorMessage()).toContain('No registered library');
    http.expectNone('/api/pano/stitch');
  });

  it('shows an error when selected assets are not yet indexed (comment #2)', () => {
    // Re-create the component with an empty apiIdMap (no assets indexed).
    TestBed.resetTestingModule();
    setup(MOCK_FOLDER, {});
    open(false);
    fixture.componentInstance.onSubmit();
    expect(fixture.componentInstance.phase()).toBe('error');
    expect(fixture.componentInstance.errorCode()).toBe('assets_not_indexed');
    expect(fixture.componentInstance.errorMessage()).toContain('not been indexed');
    http.expectNone('/api/pano/stitch');
  });

  it('submits without a strategy field when unsupported', () => {
    open(false);
    fixture.componentInstance.onSubmit();
    const call = http.expectOne('/api/pano/stitch');
    expect(call.request.body).toEqual({
      assetIds: ['aaa', 'bbb', 'ccc'],
      libraryId: MOCK_FOLDER.id,
      options: { retention: 'keep', localAlign: 'mesh' },
    });
    call.flush({ id: 'j1' }, { status: 201, statusText: 'Created' });
    expect(fixture.componentInstance.phase()).toBe('polling');
    fixture.componentInstance.onCancel();
  });

  it('includes the chosen strategy when supported', () => {
    open(true);
    fixture.componentInstance.strategy.set('tile');
    fixture.componentInstance.onSubmit();
    const call = http.expectOne('/api/pano/stitch');
    expect(call.request.body).toEqual({
      assetIds: ['aaa', 'bbb', 'ccc'],
      libraryId: MOCK_FOLDER.id,
      options: { retention: 'keep', localAlign: 'mesh', strategy: 'tile' },
    });
    call.flush({ id: 'j2' }, { status: 201, statusText: 'Created' });
    fixture.componentInstance.onCancel();
  });

  // ── Structured error code (comment #3) ────────────────────────────────────

  it('sets errorCode to pano_not_provisioned on 409 and shows settings hint', () => {
    open(false);
    fixture.componentInstance.onSubmit();
    http
      .expectOne('/api/pano/stitch')
      .flush(
        { error: 'pano_not_provisioned', message: 'Set the maple-cli path in Settings > Pano.' },
        { status: 409, statusText: 'Conflict' },
      );
    expect(fixture.componentInstance.phase()).toBe('error');
    expect(fixture.componentInstance.errorCode()).toBe('pano_not_provisioned');
    const el: HTMLElement = fixture.nativeElement;
    // The settings hint must appear, not the generic "Check server logs" text.
    fixture.detectChanges();
    expect(el.textContent).toContain('Settings');
    expect(el.textContent).not.toContain('Check the server logs');
  });

  it('sets errorCode to pano_job_running on 409 pano_job_running', () => {
    open(false);
    fixture.componentInstance.onSubmit();
    http.expectOne('/api/pano/stitch').flush(
      {
        error: 'pano_job_running',
        message: 'A panorama job is already running.',
        jobId: 'abc123',
      },
      { status: 409, statusText: 'Conflict' },
    );
    expect(fixture.componentInstance.phase()).toBe('error');
    expect(fixture.componentInstance.errorCode()).toBe('pano_job_running');
    // The generic hint should appear (not the settings hint).
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.textContent).toContain('server logs');
  });

  it('renders the provisioning message on 409 pano_not_provisioned', () => {
    open(false);
    fixture.componentInstance.onSubmit();
    http
      .expectOne('/api/pano/stitch')
      .flush(
        { error: 'pano_not_provisioned', message: 'Set the maple-cli path in Settings > Pano.' },
        { status: 409, statusText: 'Conflict' },
      );
    expect(fixture.componentInstance.phase()).toBe('error');
    expect(fixture.componentInstance.errorMessage()).toContain('Settings > Pano');
  });
});
