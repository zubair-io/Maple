import { CanActivateFn, Router } from '@angular/router';
import { inject } from '@angular/core';
import { AuthService } from './auth.service';

export const authGuard: CanActivateFn = async (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  // Hydrate from refresh cookie if we have no user yet.
  if (!auth.isSignedIn) {
    if ((await auth.refresh()) === 'refreshed') {
      try {
        await auth.loadMe();
      } catch {
        /* ignore — fall through */
      }
    }
  }
  if (auth.isSignedIn) return true;
  // Preserve the attempted URL so sign-in lands back on it — a deep link
  // (or an OS "Open with" launch parked at /open-file, #2798) shouldn't
  // dump the user at the root after authenticating. SignInComponent
  // validates the value before navigating (internal paths only).
  return router.createUrlTree(['/sign-in'], { queryParams: { returnUrl: state.url } });
};
