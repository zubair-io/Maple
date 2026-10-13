import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { PanoService, type PanoConfig } from './pano.service';
import { API_BASE_URL } from './api-base-url.token';

const CONFIG: PanoConfig = {
  maple_cli_path: '/opt/maple-cli',
  models_dir: null,
  ort_dylib_path: null,
  enabled: true,
  matcher: 'classical',
  strategy_supported: false,
  features_engine_supported: true,
  preview_supported: true,
  source: {
    maple_cli_path: 'db',
    models_dir: 'unset',
    ort_dylib_path: 'unset',
    enabled: 'db',
    matcher: 'default',
  },
};

describe('PanoService', () => {
  let svc: PanoService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        PanoService,
        { provide: API_BASE_URL, useValue: '/api' },
      ],
    });
    svc = TestBed.inject(PanoService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('stitch POSTs the full request body to /pano/stitch', () => {
    let id = '';
    const req = {
      assetIds: ['a', 'b'],
      libraryId: 'lib1',
      options: { retention: 'keep' as const, localAlign: 'mesh' as const },
    };
    svc.stitch(req).subscribe((r) => (id = r.id));
    const call = http.expectOne('/api/pano/stitch');
    expect(call.request.method).toBe('POST');
    expect(call.request.body).toEqual(req);
    call.flush({ id: 'job1' }, { status: 201, statusText: 'Created' });
    expect(id).toBe('job1');
  });

  it('stitch surfaces a 409 pano_not_provisioned as an HttpErrorResponse', () => {
    let status = 0;
    let code = '';
    svc
      .stitch({
        assetIds: ['a', 'b'],
        libraryId: 'lib1',
        options: { retention: 'keep', localAlign: 'mesh' },
      })
      .subscribe({
        error: (e) => {
          status = e.status;
          code = e.error?.error ?? '';
        },
      });
    http
      .expectOne('/api/pano/stitch')
      .flush(
        { error: 'pano_not_provisioned', message: 'configure the binary' },
        { status: 409, statusText: 'Conflict' },
      );
    expect(status).toBe(409);
    expect(code).toBe('pano_not_provisioned');
  });

  it('preview POSTs the request, alignment reference included, to /pano/preview (#4580)', () => {
    const req = {
      assetPaths: ['/lib/a.dng', '/lib/b.dng'],
      libraryId: 'lib1',
      options: { retention: 'keep' as const, localAlign: 'off' as const },
      alignmentFrom: 'prev1',
    };
    let id = '';
    svc.preview(req).subscribe((r) => (id = r.id));
    const call = http.expectOne('/api/pano/preview');
    expect(call.request.method).toBe('POST');
    expect(call.request.body).toEqual(req);
    call.flush({ id: 'job2' }, { status: 201, statusText: 'Created' });
    expect(id).toBe('job2');
  });

  it('previewImage GETs the preview PNG as a blob (#4580)', () => {
    let size = 0;
    svc.previewImage('job 2').subscribe((b) => (size = b.size));
    const call = http.expectOne('/api/pano/jobs/job%202/preview');
    expect(call.request.method).toBe('GET');
    expect(call.request.responseType).toBe('blob');
    call.flush(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }));
    expect(size).toBe(3);
  });

  it('getJob GETs /pano/jobs/:id with the id encoded', () => {
    svc.getJob('id with space').subscribe();
    const call = http.expectOne('/api/pano/jobs/id%20with%20space');
    expect(call.request.method).toBe('GET');
    call.flush({
      id: 'id with space',
      kind: 'pano_stitch',
      status: 'running',
      progress: { current: 2, total: 6 },
      result: null,
      error: null,
      cancel_requested: false,
      created_at: '',
      updated_at: '',
    });
  });

  it('cancelJob DELETEs /pano/jobs/:id', () => {
    let ok = false;
    svc.cancelJob('job1').subscribe((r) => (ok = r.ok));
    const call = http.expectOne('/api/pano/jobs/job1');
    expect(call.request.method).toBe('DELETE');
    call.flush({ ok: true });
    expect(ok).toBe(true);
  });

  it('getConfig GETs /pano/config and exposes strategy_supported', () => {
    let supported: boolean | null = null;
    svc.getConfig().subscribe((c) => (supported = c.strategy_supported));
    http.expectOne('/api/pano/config').flush(CONFIG);
    expect(supported).toBe(false);
  });

  it('putConfig PUTs only the provided patch fields', () => {
    svc.putConfig({ enabled: true }).subscribe();
    const call = http.expectOne('/api/pano/config');
    expect(call.request.method).toBe('PUT');
    expect(call.request.body).toEqual({ enabled: true });
    call.flush({ ...CONFIG, ok: true });
  });
});
