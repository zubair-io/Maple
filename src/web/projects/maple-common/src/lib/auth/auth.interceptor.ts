import { HttpInterceptorFn } from "@angular/common/http";
import { inject } from "@angular/core";
import { AuthService } from "./auth.service";
import { from, switchMap, catchError, throwError } from "rxjs";

let inflightRefresh: Promise<boolean> | null = null;

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  // Skip auth endpoints from injection.
  const skipAuthHeader = req.url.startsWith("/api/auth/");
  const withBearer =
    auth.bearer && !skipAuthHeader
      ? req.clone({ setHeaders: { Authorization: `Bearer ${auth.bearer}` } })
      : req;
  return next(withBearer).pipe(
    catchError((err) => {
      if (err?.status === 401 && !skipAuthHeader) {
        if (!inflightRefresh) {
          inflightRefresh = auth.refresh().finally(() => {
            inflightRefresh = null;
          });
        }
        return from(inflightRefresh).pipe(
          switchMap((ok) => {
            if (!ok) return throwError(() => err);
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
