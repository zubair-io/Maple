import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { AuthService } from './auth.service';
import { from, switchMap, catchError, throwError } from 'rxjs';

// Auth endpoints that establish a session and therefore must NOT have a
// bearer attached. /api/auth/me, /credentials/*, /invites/* DO need a bearer
// (they're scoped to the signed-in user) — they live under the same prefix
// but are user-context-required, not session-establishing. A blanket
// startsWith("/api/auth/") was stripping the bearer from those too, so /me
// hit the server with no Authorization header and bounced as "missing bearer".
const SESSION_BOOTSTRAP_PATHS = new Set<string>([
  '/api/auth/bootstrap',
  '/api/auth/register/options',
  '/api/auth/register/verify',
  '/api/auth/login/options',
  '/api/auth/login/verify',
  '/api/auth/dev-login',
  '/api/auth/refresh',
  '/api/auth/logout',
]);

function isSessionBootstrap(url: string): boolean {
  // Strip query string before comparing — `/api/auth/refresh?foo=bar` still matches.
  const path = url.split('?')[0];
  return SESSION_BOOTSTRAP_PATHS.has(path);
}

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const skipAuthHeader = isSessionBootstrap(req.url);
  const withBearer =
    auth.bearer && !skipAuthHeader
      ? req.clone({ setHeaders: { Authorization: `Bearer ${auth.bearer}` } })
      : req;
  return next(withBearer).pipe(
    catchError((err) => {
      if (err?.status === 401 && !skipAuthHeader) {
        // AuthService.refresh() coalesces concurrent callers (per-tab) and
        // serializes across tabs, so a 401 stampede triggers one refresh.
        return from(auth.refresh()).pipe(
          switchMap((outcome) => {
            // Only retry when we actually hold a fresh token. On `rejected`
            // the session is already cleared; on `transient` we keep the
            // session but surface the original error rather than masking it.
            if (outcome !== 'refreshed') return throwError(() => err);
            const retried = auth.bearer
              ? req.clone({
                  setHeaders: { Authorization: `Bearer ${auth.bearer}` },
                })
              : req;
            return next(retried);
          }),
        );
      }
      return throwError(() => err);
    }),
  );
};
