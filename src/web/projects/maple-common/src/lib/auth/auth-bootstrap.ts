import { EnvironmentProviders, provideAppInitializer, inject } from '@angular/core';
import { AuthService } from './auth.service';

/**
 * Silently rehydrates the session at app startup.
 *
 * The web access token lives only in memory, so a page reload always starts
 * tokenless. Without this, the first authenticated request would fire with no
 * bearer, eat a 401, and only THEN refresh — a visible round-trip (and, on a
 * guarded route, a flash of the sign-in screen). Doing one refresh up front
 * from the httpOnly cookie means a reload recovers cleanly before the first
 * request goes out.
 *
 * Before that normal refresh, this also checks for a `?lan_handoff=<code>`
 * query param — present when the page was just redirected here from the
 * public HTTPS domain after the user chose "switch to local network" (see
 * `LanSwitchService`/`AuthService.issueLanHandoffCode`). WebAuthn requires a
 * secure context the plain-HTTP LAN origin can't provide, so a fresh session
 * here is established by redeeming that one-time code instead of a passkey
 * ceremony. The code is redeemed at most once: the URL is scrubbed via
 * `history.replaceState` regardless of outcome, so it never lingers in
 * history/bookmarks and a page refresh afterward falls through to the normal
 * cookie-based refresh below.
 *
 * Finally, once the session is hydrated (or known absent), this completes a
 * pending NATIVE handoff: an app that opened this URL with
 * `?native_callback=maple-app&code_challenge=…&state=…` is waiting for a
 * one-time code. A fresh passkey ceremony hands that code over on its own, but
 * an already-signed-in browser never runs one — without this step the app waits
 * forever while the browser just shows the library (#2963).
 *
 * This intentionally BLOCKS bootstrap: `provideAppInitializer` awaits the
 * returned promise, so the app finishes booting only once the redeem (or
 * refresh, and on success `/me`) resolves. That's deliberate — we want the
 * session hydrated before any component or guard runs, trading a short
 * startup wait for a flash-free reload. A `transient`/`rejected` outcome is
 * ignored here; the route guard and interceptor make the real signed-in/out
 * decision. Every failure is swallowed so the app still boots when the API
 * is unreachable.
 */
export function provideAuthBootstrap(): EnvironmentProviders {
  return provideAppInitializer(async () => {
    const auth = inject(AuthService);
    try {
      const handoffCode = new URLSearchParams(window.location.search).get('lan_handoff');
      const redeemed = handoffCode ? await auth.redeemLanHandoff(handoffCode) : false;
      if (handoffCode) {
        const url = new URL(window.location.href);
        url.searchParams.delete('lan_handoff');
        window.history.replaceState(null, '', url.toString());
      }
      if (!redeemed && (await auth.refresh()) === 'refreshed') {
        await auth.loadMe();
      }
      // The session is now as hydrated as it is going to get. If a native app
      // opened this URL to collect an auth code, hand it over — see
      // AuthService.resumeNativeHandoff. Awaited (not fire-and-forget) so the
      // redirect goes out before the router paints the library behind it.
      await auth.resumeNativeHandoff();
    } catch {
      /* never block boot on auth hydration */
    }
  });
}
