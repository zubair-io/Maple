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
  API_BASE_URL,
  AuthService,
  InfoEnrichmentComponent,
  MapleErrorHandler,
  ObservabilityService,
  PREVIEW_VIDEO_ACCESS,
  RenderConfigService,
  authInterceptor,
  provideAuthBootstrap,
  provideFolderTreeExtension,
  provideInfoPanelExtension,
  provideSelfHostedWorkspace,
} from '@maple-common';
import { routes } from './app.routes';
import { SelfHostedSidebarExtensionComponent } from './self-hosted-sidebar-extension/self-hosted-sidebar-extension.component';

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
    provideSelfHostedWorkspace(),
    provideInfoPanelExtension(InfoEnrichmentComponent),
    provideFolderTreeExtension(SelfHostedSidebarExtensionComponent),
    {
      provide: PREVIEW_VIDEO_ACCESS,
      useFactory: () => {
        const auth = inject(AuthService);
        return { apiBase: inject(API_BASE_URL), bearer: () => auth.bearer };
      },
    },
    // GPU live-render is on by default (token factory) and the token override
    // here was a blanket kill-switch from #1560 (#1559). #1572 replaced the
    // kill-switch with per-session present-failure detection in
    // `ImageCanvasGpuPresent.open()`: after the first GPU present the worker
    // reads back the canvas; if it is all-black while a scope snapshot was
    // successfully captured the present failed — the session is torn down, GPU
    // is skipped for the rest of the page session, and the component falls back
    // to 2D. Chrome/Edge (working WebGPU) get the 16ms GPU tick; Safari /
    // headless fall back transparently on the first image open.
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
    // #1062 — bring the DB-backed GPU live-render gate up. The gate itself has
    // already warm-started from its localStorage cache synchronously; this
    // initializer only kicks the background refresh + poll, so bootstrap is
    // never blocked on the API.
    provideAppInitializer(() => inject(RenderConfigService).init()),
  ],
};
