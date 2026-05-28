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
 * This intentionally BLOCKS bootstrap: `provideAppInitializer` awaits the
 * returned promise, so the app finishes booting only once the refresh (and,
 * on success, `/me`) resolves. That's deliberate — we want the session
 * hydrated before any component or guard runs, trading a short startup wait
 * for a flash-free reload. A `transient`/`rejected` outcome is ignored here;
 * the route guard and interceptor make the real signed-in/out decision. Every
 * failure is swallowed so the app still boots when the API is unreachable.
 */
export function provideAuthBootstrap(): EnvironmentProviders {
  return provideAppInitializer(async () => {
    const auth = inject(AuthService);
    try {
      if ((await auth.refresh()) === 'refreshed') {
        await auth.loadMe();
      }
    } catch {
      /* never block boot on auth hydration */
    }
  });
}
