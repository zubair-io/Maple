import { ApplicationConfig, provideZoneChangeDetection } from '@angular/core';
import { provideRouter, withInMemoryScrolling } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { LIBRARY_BACKEND } from '@maple-common';
import { routes } from './app.routes';

// Self-Hosted: paired with the Bun API. No service worker — refreshes always
// hit the server so MongoDB state stays authoritative.
export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes, withInMemoryScrolling({ scrollPositionRestoration: 'enabled' })),
    provideHttpClient(),
    { provide: LIBRARY_BACKEND, useValue: 'self-hosted' },
  ],
};
