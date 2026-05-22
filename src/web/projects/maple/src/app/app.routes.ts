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
    loadComponent: () => import('./sign-in/sign-in.component').then((m) => m.SignInComponent),
  },
  {
    path: 'join',
    loadComponent: () => import('./sign-in/join.component').then((m) => m.JoinComponent),
  },
  // `/` IS the browse shell. The legacy `/browse` URL redirects to `/` so
  // existing bookmarks keep working. The browse shell encodes the currently-
  // opened folder as `?folder=<absPath>` so direct loads, history nav, and
  // shared links all land on the right folder.
  { path: '', canActivate: [authGuard], component: BrowseShellComponent },
  { path: 'browse', redirectTo: '', pathMatch: 'full' },
  { path: 'edit/:id', canActivate: [authGuard], component: EditorShellComponent },
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
  {
    path: 'search',
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
