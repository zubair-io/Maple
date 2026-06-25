import {
  ApplicationConfig,
  ErrorHandler,
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
  GPU_LIVE_RENDER_ENABLED,
  LIBRARY_BACKEND,
  MapleErrorHandler,
  ObservabilityService,
  authInterceptor,
  provideAuthBootstrap,
  provideLibrarySource,
} from '@maple-common';
import { routes } from './app.routes';

// Self-Hosted: paired with the Bun API. The service worker caches the app
// shell + JS/assets for fast, offline-resilient loads and caches thumbnail
// responses (see the `thumbnails` dataGroup in ngsw-config.json). Library data
// APIs are deliberately NOT cached, so MongoDB stays authoritative; the
// background app-update flow keeps the cached shell from going stale.
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
    { provide: LIBRARY_BACKEND, useValue: 'self-hosted' },
    // #1559 — the WebGPU live-render path presents a BLACK canvas on browsers
    // that advertise `navigator.gpu` but can't actually present (Safari,
    // headless). The RAW decodes fine (its readback even feeds the histogram),
    // but the visible offscreen canvas stays black, and the only fallback today
    // is for *open* failure — not a black present. Until that per-session
    // detection lands (#1559 follow-up), use the documented kill-switch so every
    // browser gets the working 2D/CPU render. Trade-off: loses the GPU 16ms tick.
    { provide: GPU_LIVE_RENDER_ENABLED, useValue: false },
    provideServiceWorker('ngsw-worker.js', {
      enabled: !isDevMode(),
      registrationStrategy: 'registerWhenStable:30000',
    }),
    // #713 — wire the global error handler to SigNoz and bring the OTel SDK up
    // from the IndexedDB-cached config at startup (no network block — the
    // initializer reads cache then refreshes in the background).
    { provide: ErrorHandler, useClass: MapleErrorHandler },
    provideAppInitializer(() => inject(ObservabilityService).init()),
    // Background app-update flow: detect a freshly-downloaded version, toast
    // the user, and hard-navigate onto the new build on the next route change.
    provideAppInitializer(() => inject(AppUpdateService).init()),
  ],
};
