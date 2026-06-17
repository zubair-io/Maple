import {
  ApplicationConfig,
  inject,
  isDevMode,
  provideAppInitializer,
  provideZonelessChangeDetection,
} from '@angular/core';
import { provideRouter, withInMemoryScrolling, withRouterConfig } from '@angular/router';
import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import { provideServiceWorker } from '@angular/service-worker';
import {
  AppUpdateService,
  LIBRARY_BACKEND,
  authInterceptor,
  provideAuthBootstrap,
  provideLibrarySource,
} from '@maple-common';
import { routes } from './app.routes';

// Hosted: browser-only build. No server; offline support via service worker.
export const appConfig: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),
    provideRouter(
      routes,
      withInMemoryScrolling({ scrollPositionRestoration: 'enabled' }),
      withRouterConfig({ paramsInheritanceStrategy: 'always' }),
    ),
    provideHttpClient(withFetch(), withInterceptors([authInterceptor])),
    provideAuthBootstrap(),
    provideLibrarySource,
    { provide: LIBRARY_BACKEND, useValue: 'hosted' },
    provideServiceWorker('ngsw-worker.js', {
      enabled: !isDevMode(),
      registrationStrategy: 'registerWhenStable:30000',
    }),
    // Background app-update flow: detect a freshly-downloaded version, toast
    // the user, and hard-navigate onto the new build on the next route change.
    provideAppInitializer(() => inject(AppUpdateService).init()),
  ],
};
