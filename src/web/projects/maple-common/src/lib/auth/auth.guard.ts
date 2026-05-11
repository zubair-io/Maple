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
