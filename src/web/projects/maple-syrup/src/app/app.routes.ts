import { Routes } from '@angular/router';
import {
  BrowseShellComponent,
  EditorShellComponent,
  PreviewShellComponent,
  ProtocolHandlerComponent,
} from '@maple-common';
import { LandingComponent } from './landing/landing.component';

// Hosted: `/` is the Landing page with two CTAs. Users enter Browse or the
// Editor explicitly from there.
const baseRoutes: Routes = [
  { path: '', component: LandingComponent },
  // M2: path-based routes replacing ?folder= and fs: scheme.
  {
    path: 'browse/:slug',
    children: [{ path: '**', component: BrowseShellComponent }],
  },
  { path: 'browse', component: BrowseShellComponent },
  {
    path: 'edit/:slug',
    children: [{ path: '**', component: EditorShellComponent }],
  },
  // Web Preview Surface Task 3 — /view/:slug/** deep-links into a fast,
  // static-image preview (grid thumbnail → display preview, no canvas/WASM).
  {
    path: 'view/:slug',
    children: [{ path: '**', component: PreviewShellComponent }],
  },
  { path: 'view', component: PreviewShellComponent },
  // Web responsive foundation (#2279): the phone-tab shell fork is retired —
  // BrowseShell is the single library surface at every width. `/library`
  // is a legacy bookmark redirect; loupe redirects to Preview (S4 dropped
  // per #619 — the Editor canvas IS the full-image view; the S5 editor
  // itself was retired once the canvas-first editor reached feature parity,
  // epic #1807 — Preview's own Edit action reaches it via `/edit/:slug/**`
  // above); search is the lazy-loaded S7 page.
  { path: 'library', redirectTo: 'browse', pathMatch: 'full' },
  { path: 'library/loupe/:id', redirectTo: 'view/:id' },
  // PWA `protocol_handlers` landing route — see manifest.webmanifest and
  // ProtocolHandlerComponent. The browser substitutes the entire
  // `web+maple://…` URL into `?url=…` (percent-encoded); the component
  // decodes it and redirects to the canonical Angular route.
  { path: 'protocol-handler', component: ProtocolHandlerComponent },
  {
    path: 'search',
    loadComponent: () => import('./search-page.component').then((m) => m.SearchPageComponent),
  },
  // Hosted settings: Account is the only surface today (signed-in identity
  // + sign-out) — see settings/account.component.ts for why it can't reuse
  // Self Hosted's AccountComponent/SettingsShellComponent directly.
  { path: 'settings', redirectTo: 'settings/account', pathMatch: 'full' },
  {
    path: 'settings/account',
    loadComponent: () => import('./settings/account.component').then((m) => m.AccountComponent),
  },
];

export const routes: Routes = [...baseRoutes, { path: '**', redirectTo: '' }];
