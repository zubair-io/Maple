import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { authInterceptor } from './auth.interceptor';
import { AuthService } from './auth.service';
import { expectRequestAfterWebLock } from './auth-test-helpers';

describe('authInterceptor', () => {
  let http: HttpClient;
  let ctrl: HttpTestingController;
  let auth: AuthService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpClient);
    ctrl = TestBed.inject(HttpTestingController);
    auth = TestBed.inject(AuthService);
    (auth as unknown as { accessToken: string | null }).accessToken = 'A1';
  });

  it('injects bearer', () => {
    http.get('/api/folders').subscribe();
    const req = ctrl.expectOne('/api/folders');
    expect(req.request.headers.get('Authorization')).toBe('Bearer A1');
    req.flush({});
  });

  it('does not renew again for signed-out background requests after session hydration fails', async () => {
    (auth as unknown as { accessToken: string | null }).accessToken = null;
    const hydration = auth.refresh();
    (await expectRequestAfterWebLock(ctrl, '/api/auth/refresh')).flush(
      {},
      { status: 401, statusText: 'Unauthorized' },
    );
    expect(await hydration).toBe('rejected');
    const errors: number[] = [];
    for (const path of ['/api/render/config', '/api/observability/config']) {
      http.get(path).subscribe({ error: (err) => errors.push(err.status) });
      const req = ctrl.expectOne(path);
      expect(req.request.headers.has('Authorization')).toBe(false);
      req.flush({}, { status: 401, statusText: 'Unauthorized' });
    }
    await Promise.resolve();
    await Promise.resolve();
    ctrl.expectNone('/api/auth/refresh');
    expect(errors).toEqual([401, 401]);
    ctrl.verify();
  });

  it('still hydrates a cookie for a tokenless request during startup', async () => {
    (auth as unknown as { accessToken: string | null }).accessToken = null;
    http.get('/api/render/config').subscribe();
    ctrl.expectOne('/api/render/config').flush({}, { status: 401, statusText: 'Unauthorized' });
    const hydration = auth.refresh();
    (await expectRequestAfterWebLock(ctrl, '/api/auth/refresh')).flush({ access_token: 'A2' });
    expect(await hydration).toBe('refreshed');
    const retried = ctrl.expectOne('/api/render/config');
    expect(retried.request.headers.get('Authorization')).toBe('Bearer A2');
    retried.flush({});
    ctrl.verify();
  });

  it('refreshes once on 401 and retries', async () => {
    vi.spyOn(auth, 'refresh').mockImplementation(async () => {
      (auth as unknown as { accessToken: string | null }).accessToken = 'A2';
      return 'refreshed';
    });
    http.get('/api/folders').subscribe();
    let req = ctrl.expectOne('/api/folders');
    req.flush({}, { status: 401, statusText: 'Unauth' });
    // The interceptor calls refresh(), then retries
    await Promise.resolve();
    await Promise.resolve();
    req = ctrl.expectOne('/api/folders');
    expect(req.request.headers.get('Authorization')).toBe('Bearer A2');
    req.flush({});
  });

  it('does not retry and surfaces the error when refresh is rejected', async () => {
    vi.spyOn(auth, 'refresh').mockResolvedValue('rejected');
    let errored = false;
    http.get('/api/folders').subscribe({ error: () => (errored = true) });
    const req = ctrl.expectOne('/api/folders');
    req.flush({}, { status: 401, statusText: 'Unauth' });
    await Promise.resolve();
    await Promise.resolve();
    ctrl.verify(); // no retry was issued
    expect(errored).toBe(true);
  });

  it('does not retry on a transient refresh outcome', async () => {
    vi.spyOn(auth, 'refresh').mockResolvedValue('transient');
    let errored = false;
    http.get('/api/folders').subscribe({ error: () => (errored = true) });
    const req = ctrl.expectOne('/api/folders');
    req.flush({}, { status: 401, statusText: 'Unauth' });
    await Promise.resolve();
    await Promise.resolve();
    ctrl.verify(); // no retry was issued
    expect(errored).toBe(true);
  });
});
