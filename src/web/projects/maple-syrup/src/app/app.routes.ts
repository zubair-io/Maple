import { Routes } from '@angular/router';
import {
  BrowseShellComponent,
  EditorShellComponent,
  PhoneSettingsStubComponent,
  PreviewShellComponent,
  ProtocolHandlerComponent,
} from '@maple-common';
import { LandingComponent } from './landing/landing.component';
import { LibraryPageComponent } from './library-page.component';

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
  // Responsive-program S1a (#597) / S2 (#623) / S5 (#625) / S7 (#622)
  // — phone-tier tab routes shared with RootShellComponent. The Library
  // tab renders the responsive grid; loupe redirects to Preview
  // (S4 dropped per #619 — the Editor canvas IS the full-image view; the S5
  // editor itself was retired once the canvas-first editor reached feature
  // parity, epic #1807 — Preview's own Edit action reaches it via
  // `/edit/:slug/**` above); search is the lazy-loaded S7 page.
  { path: 'library', component: LibraryPageComponent },
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
  { path: 'settings', component: PhoneSettingsStubComponent },
];

export const routes: Routes = [...baseRoutes, { path: '**', redirectTo: '' }];
