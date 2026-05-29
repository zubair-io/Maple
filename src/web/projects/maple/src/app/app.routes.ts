import { Routes } from '@angular/router';
import {
  BrowseShellComponent,
  EditorPageComponent,
  EditorShellComponent,
  PhoneSettingsStubComponent,
} from '@maple-common';
import { LibraryPageComponent } from './library-page.component';
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
  // S7 (#622) — responsive-program search experience. `/search` lands on
  // the new `<app-search>` (phone tab content + tablet/desktop overlay
  // payload). The rich Self-Hosted filter page (cameras, lenses, EXIF
  // ranges, vision facets) moves to `/search/advanced` so it stays
  // reachable from the responsive page's "See all" link.
  {
    path: 'search',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./search-page.component').then((m) => m.SearchPageComponent),
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
