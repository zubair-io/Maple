import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { authInterceptor } from './auth.interceptor';
import { AuthService } from './auth.service';

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
