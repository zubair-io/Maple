import { Routes } from '@angular/router';
import { isDevMode } from '@angular/core';
import {
  BrowseShellComponent,
  EditorShellComponent,
  PhoneLibraryStubComponent,
  PhoneSettingsStubComponent,
} from '@maple-common';
import { LandingComponent } from './landing/landing.component';

// Hosted: `/` is the Landing page with two CTAs. Users enter Browse or the
// Editor explicitly from there.
//
// Plan 3 M2.1 adds a `/dev/webgl-test` route gated behind `isDevMode()`.
// Production bundles tree-shake the lazy-loaded chunk away (the isDevMode()
// guard short-circuits at runtime, and @angular/build's optimizer removes
// the unreachable dynamic import).
const baseRoutes: Routes = [
  { path: '', component: LandingComponent },
  { path: 'browse', component: BrowseShellComponent },
  { path: 'edit/:id', component: EditorShellComponent },
  // Responsive-program S1a (#597) — phone-tier tab routes shared with
  // RootShellComponent. S4 / S5 / S7 / S8 will replace the stubs.
  { path: 'library', component: PhoneLibraryStubComponent },
  { path: 'library/loupe/:id', component: PhoneLibraryStubComponent },
  { path: 'library/editor/:id', component: PhoneLibraryStubComponent },
  // S7 (#622) — responsive-program search experience replaces the S1a stub.
  {
    path: 'search',
    loadComponent: () =>
      import('./search-page.component').then((m) => m.SearchPageComponent),
  },
  { path: 'settings', component: PhoneSettingsStubComponent },
];

const devRoutes: Routes = isDevMode()
  ? [
      {
        path: 'dev/webgl-test',
        // Deep relative import keeps the dev page out of the public-api
        // re-export surface. Tree-shaken away when isDevMode() is false
        // in a production build.
        loadComponent: () =>
          import('../../../maple-common/src/lib/webgl/dev/webgl-test-page.component').then(
            (m) => m.WebglTestPageComponent,
          ),
      },
    ]
  : [];

export const routes: Routes = [...baseRoutes, ...devRoutes, { path: '**', redirectTo: '' }];
