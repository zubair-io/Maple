import { CanActivateFn, Router } from "@angular/router";
import { inject } from "@angular/core";
import { AuthService } from "./auth.service";

export const authGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  if (auth.isSignedIn) return true;
  // Try silent refresh once.
  if (await auth.refresh()) {
    await auth.loadMe();
    if (auth.isSignedIn) return true;
  }
  return router.createUrlTree(["/sign-in"]);
};

export const ownerGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  return auth.isOwner ? true : router.createUrlTree(["/"]);
};
