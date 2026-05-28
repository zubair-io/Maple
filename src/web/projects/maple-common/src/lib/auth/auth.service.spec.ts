import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { AuthService, AuthUser } from './auth.service';

describe('AuthService.refresh', () => {
  let auth: AuthService;
  let ctrl: HttpTestingController;

  const signedInUser: AuthUser = { id: 'u1', email: 'a@b.c', role: 'owner' };

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    auth = TestBed.inject(AuthService);
    ctrl = TestBed.inject(HttpTestingController);
  });

  afterEach(() => ctrl.verify());

  it('on success stores the access token and reports `refreshed`', async () => {
    const p = auth.refresh();
    ctrl.expectOne('/api/auth/refresh').flush({ access_token: 'AT1' });
    expect(await p).toBe('refreshed');
    expect(auth.bearer).toBe('AT1');
  });

  it('treats a 401 as a genuine rejection and clears the session', async () => {
    auth.user.set(signedInUser);
    const p = auth.refresh();
    ctrl
      .expectOne('/api/auth/refresh')
      .flush({ error: 'no refresh token' }, { status: 401, statusText: 'Unauth' });
    expect(await p).toBe('rejected');
    expect(auth.user()).toBeNull();
    expect(auth.bearer).toBeNull();
  });

  it('treats a 5xx as transient and PRESERVES the session', async () => {
    auth.user.set(signedInUser);
    const p = auth.refresh();
    ctrl
      .expectOne('/api/auth/refresh')
      .flush({ error: 'boom' }, { status: 503, statusText: 'Unavailable' });
    expect(await p).toBe('transient');
    expect(auth.user()).toEqual(signedInUser); // still signed in
  });

  it('treats a network error (status 0) as transient and PRESERVES the session', async () => {
    auth.user.set(signedInUser);
    const p = auth.refresh();
    ctrl.expectOne('/api/auth/refresh').error(new ProgressEvent('error'));
    expect(await p).toBe('transient');
    expect(auth.user()).toEqual(signedInUser);
  });

  it('treats a 429 rate-limit as transient and PRESERVES the session', async () => {
    auth.user.set(signedInUser);
    const p = auth.refresh();
    ctrl
      .expectOne('/api/auth/refresh')
      .flush({ error: 'rate limited' }, { status: 429, statusText: 'Too Many' });
    expect(await p).toBe('transient');
    expect(auth.user()).toEqual(signedInUser);
  });

  it('coalesces concurrent callers onto a single network refresh', async () => {
    const a = auth.refresh();
    const b = auth.refresh();
    // Only one HTTP request is issued despite two callers.
    ctrl.expectOne('/api/auth/refresh').flush({ access_token: 'AT2' });
    expect(await a).toBe('refreshed');
    expect(await b).toBe('refreshed');
  });
});
