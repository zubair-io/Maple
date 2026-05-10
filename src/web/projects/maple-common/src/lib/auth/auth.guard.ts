import { CanActivateFn, Router } from "@angular/router";
import { inject } from "@angular/core";
import { AuthService } from "./auth.service";

export const authGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  // Hydrate from refresh cookie if we have no user yet.
  if (!auth.isSignedIn) {
    if (await auth.refresh()) {
      try { await auth.loadMe(); } catch { /* ignore — fall through */ }
    }
  }
  if (auth.isSignedIn) return true;
  return router.createUrlTree(["/sign-in"]);
};

export const ownerGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  // Defensive: if authGuard took the isSignedIn shortcut without ever
  // running loadMe (e.g., another tab populated the access token but this
  // tab still has user=null), the role field may be missing. Hydrate.
  if (auth.isSignedIn && !auth.user()?.role) {
    try { await auth.loadMe(); } catch { /* ignore */ }
  }
  return auth.isOwner ? true : router.createUrlTree(["/"]);
};
