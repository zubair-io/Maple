import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { APP_INITIALIZER } from '@angular/core';
import { provideAuthBootstrap } from './auth-bootstrap';
import { AuthService } from './auth.service';

// Exercises the `?lan_handoff=<code>` redemption + scrub path of
// provideAuthBootstrap() (see lan-switch.service.ts — LanSwitchService.switchTo
// now forwards the current app route through the redirect, not just the LAN
// origin's root). The scrub uses `history.replaceState` and must leave the
// rest of the URL — path (including already-encoded segments) and any other
// query params — untouched, deleting only `lan_handoff`.
describe('provideAuthBootstrap lan_handoff redemption', () => {
  let redeemLanHandoff: ReturnType<typeof vi.fn>;
  let refresh: ReturnType<typeof vi.fn>;
  let loadMe: ReturnType<typeof vi.fn>;

  // provideAppInitializer() registers the bootstrap function as a multi
  // APP_INITIALIZER provider. Running it here (instead of `ApplicationRef`'s
  // normal bootstrap, which unit tests never trigger) mirrors exactly what
  // `ApplicationInitStatus.runInitializers()` does internally, but through
  // the public `TestBed` API rather than a private runtime method.
  function boot(): Promise<void> {
    const appInits = TestBed.inject(APP_INITIALIZER) as Array<() => unknown>;
    return TestBed.runInInjectionContext(() => Promise.all(appInits.map((fn) => fn()))).then(
      () => undefined,
    );
  }

  beforeEach(() => {
    redeemLanHandoff = vi.fn();
    refresh = vi.fn().mockResolvedValue('rejected');
    loadMe = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        provideAuthBootstrap(),
        { provide: AuthService, useValue: { redeemLanHandoff, refresh, loadMe } },
      ],
    });
  });

  afterEach(() => window.history.replaceState({}, '', '/'));

  it('redeems the code and scrubs only lan_handoff, preserving the route path', async () => {
    redeemLanHandoff.mockResolvedValue(true);
    window.history.replaceState({}, '', '/edit/photos/raws/test_0008.RAF?lan_handoff=CODE123');

    await boot();

    expect(redeemLanHandoff).toHaveBeenCalledWith('CODE123');
    expect(window.location.pathname).toBe('/edit/photos/raws/test_0008.RAF');
    expect(window.location.search).toBe('');
  });

  it('preserves an already-encoded path segment (asset name with a space) through the scrub', async () => {
    redeemLanHandoff.mockResolvedValue(true);
    window.history.replaceState(
      {},
      '',
      '/edit/photos/raws/test%20file%200008.RAF?lan_handoff=CODE123',
    );

    await boot();

    expect(redeemLanHandoff).toHaveBeenCalledWith('CODE123');
    expect(window.location.pathname).toBe('/edit/photos/raws/test%20file%200008.RAF');
    expect(window.location.search).toBe('');
  });

  it('preserves other query params on the route, deleting only lan_handoff', async () => {
    redeemLanHandoff.mockResolvedValue(true);
    window.history.replaceState({}, '', '/browse?sort=date&lan_handoff=CODE123');

    await boot();

    expect(redeemLanHandoff).toHaveBeenCalledWith('CODE123');
    expect(window.location.pathname).toBe('/browse');
    expect(window.location.search).toBe('?sort=date');
  });

  it('scrubs lan_handoff even when redemption fails, then falls through to a normal refresh', async () => {
    redeemLanHandoff.mockResolvedValue(false);
    window.history.replaceState({}, '', '/edit/photos/raws/test_0008.RAF?lan_handoff=bad-code');

    await boot();

    expect(window.location.search).toBe('');
    expect(refresh).toHaveBeenCalled();
  });

  it('does nothing lan_handoff-specific when the param is absent', async () => {
    window.history.replaceState({}, '', '/browse');

    await boot();

    expect(redeemLanHandoff).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalled();
  });
});
