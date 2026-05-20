import { Routes } from '@angular/router';
import { BrowseShellComponent, EditorShellComponent } from '@maple-common';
// authGuard is not yet exported from @maple-common's public-api (see Task C6);
// imported via deep relative path in the meantime so this task can land
// independently of C6.
import { authGuard } from '../../../maple-common/src/lib/auth/auth.guard';

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
  // `/settings` → Workers for owners, Account for everyone else. The card-
  // grid landing was replaced by the sidebar shell in v0.2; non-owners
  // can't reach Workers, so they land on Account instead.
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
    loadComponent: () =>
      import('./settings/users/users.component').then((m) => m.UsersComponent),
  },
  // Enrichment was folded into Workers. The redirect preserves any
  // existing bookmarks; the `face`/`describe`/`geocode` fragment opens
  // the matching row in the new combined view.
  { path: 'settings/enrichment', redirectTo: 'settings/workers', pathMatch: 'full' },
  {
    path: 'settings/workers',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./settings/workers/workers.component').then((m) => m.WorkersComponent),
  },
  {
    path: 'search',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./search/search.component').then((m) => m.SearchComponent),
  },
  // People — face-cluster identities. Same gating as `/settings/users`.
  // The `:id` variant deep-links into the detail panel.
  {
    path: 'people',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./people/people.component').then((m) => m.PeopleComponent),
  },
  {
    path: 'people/:id',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./people/people.component').then((m) => m.PeopleComponent),
  },
  { path: '**', redirectTo: 'browse' },
];
