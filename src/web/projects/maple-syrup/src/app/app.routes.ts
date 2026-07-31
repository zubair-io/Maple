import { Routes } from '@angular/router';
import {
  BrowseShellComponent,
  PreviewShellComponent,
  ProtocolHandlerComponent,
} from '@maple-common';
import { LandingComponent } from './landing/landing.component';
import { HostedEditorRouteComponent } from './hosted-editor-route/hosted-editor-route.component';

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
    children: [{ path: '**', component: HostedEditorRouteComponent }],
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
  // above). Hosted has no server search index or account/auth surface, so
  // those Self Hosted routes are intentionally absent.
  { path: 'library', redirectTo: 'browse', pathMatch: 'full' },
  { path: 'library/loupe/:id', redirectTo: 'view/:id' },
  // PWA `protocol_handlers` landing route — see manifest.webmanifest and
  // ProtocolHandlerComponent. The browser substitutes the entire
  // `web+maple://…` URL into `?url=…` (percent-encoded); the component
  // decodes it and redirects to the canonical Angular route.
  { path: 'protocol-handler', component: ProtocolHandlerComponent },
];

export const routes: Routes = [...baseRoutes, { path: '**', redirectTo: '' }];
