import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

describe('AuthService native code handoff (#856)', () => {
  const CHALLENGE = 'A'.repeat(43); // valid base64url S256 length
  const STATE = 'state-abcdef';
  let auth: AuthService;
  let ctrl: HttpTestingController;

  beforeEach(() => {
    window.history.replaceState(
      {},
      '',
      `/?native_callback=maple-app&code_challenge=${CHALLENGE}&state=${STATE}`,
    );
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    auth = TestBed.inject(AuthService);
    ctrl = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    ctrl.verify();
    window.history.replaceState({}, '', '/');
  });

  it('treats an allowlisted scheme as the native shell', () => {
    expect(auth.isNativeShell).toBe(true);
  });

  it('hands the app a one-time CODE (not tokens) and echoes state', async () => {
    const navigated: string[] = [];
    (auth as unknown as { navigateTo: (u: string) => void }).navigateTo = (u) => navigated.push(u);

    const p = (
      auth as unknown as { postNativeAuthSuccess: () => Promise<void> }
    ).postNativeAuthSuccess();
    const req = ctrl.expectOne('/api/auth/native-code');
    expect(req.request.body).toEqual({ code_challenge: CHALLENGE, state: STATE });
    req.flush({ code: 'CODE123' });
    await p;

    // A code + state — never an access/refresh token — in the redirect.
    expect(navigated).toEqual([`maple-app://auth-success?code=CODE123&state=${STATE}`]);
  });
});

describe('AuthService ignores an unknown native_callback scheme (#856)', () => {
  afterEach(() => window.history.replaceState({}, '', '/'));

  it('does not treat an attacker-named scheme as the native shell', () => {
    window.history.replaceState(
      {},
      '',
      `/?native_callback=evil-app&code_challenge=${'A'.repeat(43)}&state=state-abcdef`,
    );
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    expect(TestBed.inject(AuthService).isNativeShell).toBe(false);
  });
});

describe('AuthService LAN handoff', () => {
  let auth: AuthService;
  let ctrl: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    auth = TestBed.inject(AuthService);
    ctrl = TestBed.inject(HttpTestingController);
  });

  afterEach(() => ctrl.verify());

  it('issueLanHandoffCode returns the minted code', async () => {
    const p = auth.issueLanHandoffCode();
    ctrl.expectOne('/api/auth/lan-handoff').flush({ code: 'CODE123' });
    expect(await p).toBe('CODE123');
  });

  it('issueLanHandoffCode returns null on failure rather than throwing', async () => {
    const p = auth.issueLanHandoffCode();
    ctrl
      .expectOne('/api/auth/lan-handoff')
      .flush({ error: 'no bearer' }, { status: 401, statusText: 'Unauthorized' });
    expect(await p).toBeNull();
  });

  it('redeemLanHandoff applies the returned session and reports success', async () => {
    const p = auth.redeemLanHandoff('CODE123');
    const req = ctrl.expectOne('/api/auth/lan-handoff/redeem');
    expect(req.request.body).toEqual({ code: 'CODE123' });
    req.flush({
      access_token: 'AT-lan',
      user: { id: 'u1', email: 'a@b.c', role: 'owner' },
    });
    expect(await p).toBe(true);
    expect(auth.bearer).toBe('AT-lan');
    expect(auth.user()).toEqual({ id: 'u1', email: 'a@b.c', role: 'owner' });
  });

  it('redeemLanHandoff reports failure on an invalid/expired code and applies nothing', async () => {
    const p = auth.redeemLanHandoff('bad-code');
    ctrl
      .expectOne('/api/auth/lan-handoff/redeem')
      .flush({ error: 'invalid or expired code' }, { status: 400, statusText: 'Bad Request' });
    expect(await p).toBe(false);
    expect(auth.bearer).toBeNull();
  });
});

describe('AuthService service API keys', () => {
  let auth: AuthService;
  let ctrl: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    auth = TestBed.inject(AuthService);
    ctrl = TestBed.inject(HttpTestingController);
  });

  afterEach(() => ctrl.verify());

  it('lists key metadata without requesting plaintext secrets', () => {
    const metadata = {
      keyId: '0000000000000001',
      prefix: 'maple_sk_0123456789abcdef',
      name: 'SugarMaple',
      scopes: ['assets:search'],
      createdAt: '2026-07-26T12:00:00.000Z',
      expiresAt: null,
      revokedAt: null,
      lastUsedAt: null,
    };
    let result: unknown;

    auth.listServiceApiKeys().subscribe((keys) => (result = keys));
    ctrl.expectOne('/api/admin/service-api-keys').flush({ keys: [metadata] });

    expect(result).toEqual([metadata]);
  });

  it('creates a search-only key with a fresh step-up token', async () => {
    (auth as unknown as { stepUp: () => Promise<string> }).stepUp = vi
      .fn()
      .mockResolvedValue('STEP-UP');

    const createdPromise = auth.createServiceApiKey('SugarMaple', '2026-10-24T12:00:00.000Z');
    await Promise.resolve();
    const req = ctrl.expectOne('/api/admin/service-api-keys');
    expect(req.request.method).toBe('POST');
    expect(req.request.headers.get('X-Step-Up')).toBe('STEP-UP');
    expect(req.request.body).toEqual({
      name: 'SugarMaple',
      scopes: ['assets:search'],
      expiresAt: '2026-10-24T12:00:00.000Z',
    });
    req.flush({
      key: 'test-service-key',
      keyId: '0000000000000001',
      prefix: 'maple_sk_0123456789abcdef',
      name: 'SugarMaple',
      scopes: ['assets:search'],
      createdAt: '2026-07-26T12:00:00.000Z',
      expiresAt: '2026-10-24T12:00:00.000Z',
    });

    expect((await createdPromise).key).toBe('test-service-key');
  });

  it('revokes an encoded key id with a fresh step-up token', async () => {
    (auth as unknown as { stepUp: () => Promise<string> }).stepUp = vi
      .fn()
      .mockResolvedValue('STEP-UP');

    const revokePromise = auth.revokeServiceApiKey('id/with space');
    await Promise.resolve();
    const req = ctrl.expectOne('/api/admin/service-api-keys/id%2Fwith%20space');
    expect(req.request.method).toBe('DELETE');
    expect(req.request.headers.get('X-Step-Up')).toBe('STEP-UP');
    req.flush(null);

    await expect(revokePromise).resolves.toBeUndefined();
  });
});
