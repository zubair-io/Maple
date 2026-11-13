import { CanActivateFn, Router, UrlTree } from '@angular/router';
import { inject } from '@angular/core';
import { AuthService } from './auth.service';

async function requireSignIn(
  auth: AuthService,
  router: Router,
  attemptedUrl: string,
): Promise<true | UrlTree> {
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
  return router.createUrlTree(['/sign-in'], { queryParams: { returnUrl: attemptedUrl } });
}

export const authGuard: CanActivateFn = (_route, state) =>
  requireSignIn(inject(AuthService), inject(Router), state.url);

/** Operator pages: a signed-in member lands on their own account page instead
 * of a form whose every write the API refuses with 403. */
export const ownerGuard: CanActivateFn = async (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  const signedIn = await requireSignIn(auth, router, state.url);
  if (signedIn !== true) return signedIn;
  return auth.isOwner ? true : router.createUrlTree(['/settings/account']);
};
