import { Routes } from '@angular/router';
import { BrowseShellComponent, EditorShellComponent } from '@maple-common';
// authGuard is not yet exported from @maple-common's public-api (see Task C6);
// imported via deep relative path in the meantime so this task can land
// independently of C6.
import { authGuard, ownerGuard } from '../../../maple-common/src/lib/auth/auth.guard';

// Self-Hosted: the server already hosts the library, so the root path goes
// straight to /browse. No landing page. All content routes are gated behind
// `authGuard`; unauthenticated users are redirected to `/sign-in`.
export const routes: Routes = [
  {
    path: 'sign-in',
    loadComponent: () =>
      import('./sign-in/sign-in.component').then((m) => m.SignInComponent),
  },
  {
    path: 'join',
    loadComponent: () =>
      import('./sign-in/join.component').then((m) => m.JoinComponent),
  },
  // `/` redirects to `/browse`; the browse route's authGuard handles the
  // unauthenticated case. canActivate here is invalid — Angular runs
  // redirects BEFORE guards, so the guard would never fire (NG04014).
  { path: '', redirectTo: 'browse', pathMatch: 'full' },
  { path: 'browse', canActivate: [authGuard], component: BrowseShellComponent },
  { path: 'edit/:id', canActivate: [authGuard], component: EditorShellComponent },
  {
    path: 'settings/account',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./settings/account/account.component').then((m) => m.AccountComponent),
  },
  {
    path: 'settings/users',
    canActivate: [authGuard, ownerGuard],
    loadComponent: () =>
      import('./settings/users/users.component').then((m) => m.UsersComponent),
  },
  {
    path: 'settings/indexer',
    canActivate: [authGuard, ownerGuard],
    loadComponent: () =>
      import('./settings/indexer/indexer.component').then((m) => m.IndexerComponent),
  },
  {
    path: 'settings/enrichment',
    canActivate: [authGuard, ownerGuard],
    loadComponent: () =>
      import('./settings/enrichment/enrichment.component').then(
        (m) => m.EnrichmentComponent,
      ),
  },
  {
    path: 'search',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./search/search.component').then((m) => m.SearchComponent),
  },
  { path: '**', redirectTo: 'browse' },
];
