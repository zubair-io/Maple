import { Routes } from '@angular/router';
import {
  BrowseShellComponent,
  EditorPageComponent,
  EditorShellComponent,
  PreviewShellComponent,
  ProtocolHandlerComponent,
  authGuard,
} from '@maple-common';
import { LibraryPageComponent } from './library-page.component';

// Self-Hosted: the server already hosts the library, so the root path goes
// straight to /browse. No landing page. All content routes are gated behind
// `authGuard`; unauthenticated users are redirected to `/sign-in`.
export const routes: Routes = [
  {
    path: 'sign-in',
    loadComponent: () => import('./sign-in/sign-in.component').then((m) => m.SignInComponent),
  },
  {
    path: 'join',
    loadComponent: () => import('./sign-in/join.component').then((m) => m.JoinComponent),
  },
  // M2: path-based routes replacing ?folder= and fs: scheme.
  // /browse/:slug/** deep-links into a folder by MapleAddress (slug:relPath).
  // /edit/:slug/**  deep-links into an image by MapleAddress.
  // Legacy '/' redirects to /browse so the root URL stays usable.
  { path: '', redirectTo: 'browse', pathMatch: 'full' },
  {
    path: 'browse/:slug',
    canActivate: [authGuard],
    children: [{ path: '**', component: BrowseShellComponent }],
  },
  { path: 'browse', canActivate: [authGuard], component: BrowseShellComponent },
  {
    path: 'edit/:slug',
    canActivate: [authGuard],
    children: [{ path: '**', component: EditorShellComponent }],
  },
  // Web Preview Surface Task 3 — /view/:slug/** deep-links into a fast,
  // static-image preview (grid thumbnail → display preview, no canvas/WASM).
  {
    path: 'view/:slug',
    canActivate: [authGuard],
    children: [{ path: '**', component: PreviewShellComponent }],
  },
  { path: 'view', canActivate: [authGuard], component: PreviewShellComponent },
  // Responsive-program S1a (#597) — phone-tier tab routes. The same
  // router serves both shells; RootShellComponent picks which wrapper
  // to render based on LayoutService.layout(). On phone the bottom-nav
  // links point at `/library`, `/search`, `/settings`; the loupe and
  // editor entries are placeholders that S4 / S5 will replace.
  { path: 'library', canActivate: [authGuard], component: LibraryPageComponent },
  // S2 (#623) / S5 (#625): the loupe sub-route is gone — the Editor
  // canvas IS the full-image view (per PR #619 spec drop). Loupe
  // bookmarks redirect into the S5 Editor; the editor sub-route is
  // wired directly to EditorPageComponent for the stacked #652 work.
  { path: 'library/loupe/:id', redirectTo: 'library/editor/:id' },
  { path: 'library/editor/:id', canActivate: [authGuard], component: EditorPageComponent },
  // PWA `protocol_handlers` landing route — see manifest.webmanifest and
  // ProtocolHandlerComponent. The browser substitutes the entire
  // `web+maple://…` URL into `?url=…` (percent-encoded); the component
  // decodes it and redirects to the canonical Angular route.
  {
    path: 'protocol-handler',
    canActivate: [authGuard],
    component: ProtocolHandlerComponent,
  },
  // `/settings` lands on Workers. The card-grid landing was replaced by
  // the sidebar shell in v0.2. Non-owners hit authGuard inside
  // settings/workers and bounce; making the redirect role-aware (Account
  // for non-owners) is tracked as a follow-up.
  { path: 'settings', redirectTo: 'settings/workers', pathMatch: 'full' },
  {
    path: 'settings/account',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./settings/account/account.component').then((m) => m.AccountComponent),
  },
  {
    path: 'settings/users',
    canActivate: [authGuard],
    loadComponent: () => import('./settings/users/users.component').then((m) => m.UsersComponent),
  },
  // Enrichment was folded into Workers; the redirect preserves any
  // existing bookmarks. Fragment-driven row expansion is not implemented
  // yet — bookmarks like `/settings/workers#describe` land on the page
  // without auto-opening the row.
  { path: 'settings/enrichment', redirectTo: 'settings/workers', pathMatch: 'full' },
  {
    path: 'settings/workers',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./settings/workers/workers.component').then((m) => m.WorkersComponent),
  },
  // /settings/backup briefly shipped as its own page (#1073); Backup is now a
  // group on the Workers page, so redirect the old URL instead of 404ing —
  // same pattern as the settings/enrichment redirect above.
  { path: 'settings/backup', redirectTo: 'settings/workers', pathMatch: 'full' },
  // #1231 — Panorama stitching operator config (binary path + models dir + toggle).
  {
    path: 'settings/pano',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./settings/pano/pano-settings.component').then((m) => m.PanoSettingsComponent),
  },
  // #742 — Imports: copy a server-local folder into a registered library.
  {
    path: 'settings/imports',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./settings/imports/imports.component').then((m) => m.ImportsComponent),
  },
  // #713 — SigNoz / OpenTelemetry config + toggle. Uses `authGuard` like the
  // other settings routes; owner-only visibility is handled by the settings
  // nav (same convention as settings/users + settings/workers), not a route
  // guard. The server endpoint sits behind requireAuth.
  {
    path: 'settings/observability',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./settings/observability/observability.component').then(
        (m) => m.ObservabilityComponent,
      ),
  },
  // #1757 — Cloudflare R2 thumbnail-mirror config + JWT-secret reveal for
  // the Worker's `wrangler secret put`. Owner-only visibility is handled by
  // the settings nav, not a route guard (same convention as observability).
  {
    path: 'settings/cloudflare',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./settings/cloudflare/cloudflare.component').then((m) => m.CloudflareComponent),
  },
  // LAN address discovery — lets an operator override the auto-detected
  // local network address self-hosted clients prefer over the public URL
  // when they're on the same network as the server. Same route-guard
  // convention as settings/observability above.
  {
    path: 'settings/network',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./settings/network/network-settings.component').then(
        (m) => m.NetworkSettingsComponent,
      ),
  },
  // S7 (#622) — responsive-program search experience. `/search` lands on
  // the new `<app-search>` (phone tab content + tablet/desktop overlay
  // payload). The rich Self-Hosted filter page (cameras, lenses, EXIF
  // ranges, vision facets) moves to `/search/advanced` so it stays
  // reachable from the responsive page's "See all" link.
  {
    path: 'search',
    canActivate: [authGuard],
    loadComponent: () => import('./search-page.component').then((m) => m.SearchPageComponent),
  },
  {
    path: 'search/advanced',
    canActivate: [authGuard],
    loadComponent: () => import('./search/search.component').then((m) => m.SearchComponent),
  },
  // People — face-cluster identities. Lives inside the Settings shell;
  // the `:id` variant deep-links into the detail view. The legacy
  // `/people` and `/people/:id` URLs are client-side redirects (Angular
  // router-level, not HTTP 301) to the new location so existing
  // bookmarks and in-app links (e.g. info-tab face badges before the
  // settings/people migration) still resolve. The SPA index.html catches
  // either entrypoint and the router takes it from there.
  {
    path: 'settings/people',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./settings/people/people.component').then((m) => m.PeopleComponent),
  },
  // Hidden page MUST precede the `:id` detail route — otherwise the router
  // would match "hidden" as a person id and route to the people detail view.
  {
    path: 'settings/people/hidden',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./settings/people/hidden-people.component').then((m) => m.HiddenPeopleComponent),
  },
  {
    path: 'settings/people/:id',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./settings/people/people.component').then((m) => m.PeopleComponent),
  },
  { path: 'people', redirectTo: 'settings/people', pathMatch: 'full' },
  { path: 'people/:id', redirectTo: 'settings/people/:id' },
  { path: '**', redirectTo: '' },
];
