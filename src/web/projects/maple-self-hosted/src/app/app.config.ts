import { ApplicationConfig, provideZonelessChangeDetection } from '@angular/core';
import { provideRouter, withInMemoryScrolling } from '@angular/router';
import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import { LIBRARY_BACKEND, authInterceptor } from '@maple-common';
import { routes } from './app.routes';

// Self-Hosted: paired with the Bun API. No service worker — refreshes always
// hit the server so MongoDB state stays authoritative.
export const appConfig: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),
    provideRouter(routes, withInMemoryScrolling({ scrollPositionRestoration: 'enabled' })),
    provideHttpClient(withFetch(), withInterceptors([authInterceptor])),
    { provide: LIBRARY_BACKEND, useValue: 'self-hosted' },
  ],
};
