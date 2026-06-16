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
 * @param absPathMap - local assetId → absolute filesystem path map
 */
function makeLibraryStateMock(
  folderOverride: typeof MOCK_FOLDER | null = MOCK_FOLDER,
  apiIdMap: Record<string, string> = { a1: 'aaa', a2: 'bbb', a3: 'ccc' },
  absPathMap: Record<string, string> = {
    a1: '/Volumes/Photos/img1.dng',
    a2: '/Volumes/Photos/img2.dng',
    a3: '/Volumes/Photos/img3.dng',
  },
) {
  return {
    selectedSourceId: () => 'fs:/Volumes/Photos',
    currentRegisteredFolder: () => folderOverride,
    apiIdFor: (id: string) => apiIdMap[id],
    absPathFor: (id: string) => absPathMap[id],
  };
}

describe('PanoDialogComponent', () => {
  let fixture: ComponentFixture<PanoDialogComponent>;
  let http: HttpTestingController;

  function setup(
    folderOverride: typeof MOCK_FOLDER | null = MOCK_FOLDER,
    apiIdMap: Record<string, string> = { a1: 'aaa', a2: 'bbb', a3: 'ccc' },
    absPathMap: Record<string, string> = {
      a1: '/Volumes/Photos/img1.dng',
      a2: '/Volumes/Photos/img2.dng',
      a3: '/Volumes/Photos/img3.dng',
    },
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
          useValue: makeLibraryStateMock(folderOverride, apiIdMap, absPathMap),
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

  // ── LOAD-BEARING: server-authoritative path-based submission (#1311) ──────────

  it('submits assetPaths and libraryId; proceeds to polling even when apiIdMap is empty', () => {
    // The client's API id map is empty (assets not yet in the client cache),
    // but the abs-path map is populated. The server resolves paths → ids.
    // The submit should NOT error; it should send assetPaths to the server.
    TestBed.resetTestingModule();
    setup(
      MOCK_FOLDER,
      {},
      {
        a1: '/Volumes/Photos/img1.dng',
        a2: '/Volumes/Photos/img2.dng',
        a3: '/Volumes/Photos/img3.dng',
      },
    );
    open(false);
    fixture.componentInstance.onSubmit();
    const call = http.expectOne('/api/pano/stitch');
    expect(call.request.body.assetPaths).toEqual([
      '/Volumes/Photos/img1.dng',
      '/Volumes/Photos/img2.dng',
      '/Volumes/Photos/img3.dng',
    ]);
    expect(call.request.body.libraryId).toBe(MOCK_FOLDER.id);
    // assetIds not sent when empty
    expect(call.request.body.assetIds).toBeUndefined();
    call.flush({ id: 'j1' }, { status: 201, statusText: 'Created' });
    expect(fixture.componentInstance.phase()).toBe('polling');
    fixture.componentInstance.onCancel();
  });

  it('sends a path for path-having assets and an id only for id-only assets (#1313)', () => {
    // a1, a2 are referenced by path; a3 has no path, only an API id. The client
    // must send paths for a1/a2 and the id for a3 — never both for one asset.
    TestBed.resetTestingModule();
    setup(
      MOCK_FOLDER,
      { a3: 'ccc' },
      { a1: '/Volumes/Photos/img1.dng', a2: '/Volumes/Photos/img2.dng' },
    );
    open(false);
    fixture.componentInstance.onSubmit();
    const call = http.expectOne('/api/pano/stitch');
    expect(call.request.body.assetPaths).toEqual([
      '/Volumes/Photos/img1.dng',
      '/Volumes/Photos/img2.dng',
    ]);
    expect(call.request.body.assetIds).toEqual(['ccc']);
    expect(call.request.body.libraryId).toBe(MOCK_FOLDER.id);
    call.flush({ id: 'j1' }, { status: 201, statusText: 'Created' });
    expect(fixture.componentInstance.phase()).toBe('polling');
    fixture.componentInstance.onCancel();
  });

  it('omits the API id when the same asset also has a path (no stale-id shadowing, #1313)', () => {
    // Default mock: every asset has BOTH a path and an id. The client must send
    // only the (fresh) paths and omit the (possibly stale) ids entirely.
    open(false);
    fixture.componentInstance.onSubmit();
    const call = http.expectOne('/api/pano/stitch');
    expect(call.request.body.assetPaths).toEqual([
      '/Volumes/Photos/img1.dng',
      '/Volumes/Photos/img2.dng',
      '/Volumes/Photos/img3.dng',
    ]);
    expect(call.request.body.assetIds).toBeUndefined();
    call.flush({ id: 'j1' }, { status: 201, statusText: 'Created' });
    expect(fixture.componentInstance.phase()).toBe('polling');
    fixture.componentInstance.onCancel();
  });

  it('proceeds to polling when the server reports indexing:N (index-on-demand)', () => {
    TestBed.resetTestingModule();
    setup(
      MOCK_FOLDER,
      {},
      {
        a1: '/Volumes/Photos/img1.dng',
        a2: '/Volumes/Photos/img2.dng',
        a3: '/Volumes/Photos/img3.dng',
      },
    );
    open(false);
    fixture.componentInstance.onSubmit();
    const call = http.expectOne('/api/pano/stitch');
    // Server indexed 3 files on-demand; still returns a job id.
    call.flush({ id: 'j2', indexing: 3 }, { status: 201, statusText: 'Created' });
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

  it('shows an error when the client has neither paths nor ids for the selected assets', () => {
    // Both maps are empty — client cannot provide any reference.
    TestBed.resetTestingModule();
    setup(MOCK_FOLDER, {}, {});
    open(false);
    fixture.componentInstance.onSubmit();
    expect(fixture.componentInstance.phase()).toBe('error');
    expect(fixture.componentInstance.errorCode()).toBe('assets_not_indexed');
    http.expectNone('/api/pano/stitch');
  });

  it('fails fast when even one selected asset has neither a path nor an id (#1313)', () => {
    // a1 has a path + id, a2 has a path, a3 has NEITHER. The whole submit must
    // error rather than silently stitching only a1 + a2 (fewer than selected).
    TestBed.resetTestingModule();
    setup(
      MOCK_FOLDER,
      { a1: 'aaa' },
      { a1: '/Volumes/Photos/img1.dng', a2: '/Volumes/Photos/img2.dng' },
    );
    open(false);
    fixture.componentInstance.onSubmit();
    expect(fixture.componentInstance.phase()).toBe('error');
    expect(fixture.componentInstance.errorCode()).toBe('assets_not_indexed');
    http.expectNone('/api/pano/stitch');
  });

  it('submits API ids as assetIds when assets have no local path (#1313)', () => {
    // Cloud-hosted style: assets carry API ids but no absolute file path, so
    // the client sends assetIds (and no assetPaths). The library folder id is
    // MOCK_FOLDER.id. The handler expects MongoDB ObjectId hex strings.
    TestBed.resetTestingModule();
    setup(MOCK_FOLDER, { a1: 'aaa', a2: 'bbb', a3: 'ccc' }, {});
    open(false);
    fixture.componentInstance.onSubmit();
    const call = http.expectOne('/api/pano/stitch');
    expect(call.request.body.assetIds).toEqual(['aaa', 'bbb', 'ccc']);
    expect(call.request.body.assetPaths).toBeUndefined();
    expect(call.request.body.libraryId).toBe(MOCK_FOLDER.id);
    expect(call.request.body.options).toEqual({ retention: 'keep', localAlign: 'mesh' });
    call.flush({ id: 'j1' }, { status: 201, statusText: 'Created' });
    expect(fixture.componentInstance.phase()).toBe('polling');
    fixture.componentInstance.onCancel();
  });

  it('submits without a strategy field when unsupported', () => {
    open(false);
    fixture.componentInstance.onSubmit();
    const call = http.expectOne('/api/pano/stitch');
    expect(call.request.body.options).toEqual({ retention: 'keep', localAlign: 'mesh' });
    call.flush({ id: 'j1' }, { status: 201, statusText: 'Created' });
    expect(fixture.componentInstance.phase()).toBe('polling');
    fixture.componentInstance.onCancel();
  });

  it('includes the chosen strategy when supported', () => {
    open(true);
    fixture.componentInstance.strategy.set('tile');
    fixture.componentInstance.onSubmit();
    const call = http.expectOne('/api/pano/stitch');
    expect(call.request.body.options).toEqual({
      retention: 'keep',
      localAlign: 'mesh',
      strategy: 'tile',
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
