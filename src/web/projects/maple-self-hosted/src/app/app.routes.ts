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
  { path: '', canActivate: [authGuard], redirectTo: 'browse', pathMatch: 'full' },
  { path: 'browse', canActivate: [authGuard], component: BrowseShellComponent },
  { path: 'edit/:id', canActivate: [authGuard], component: EditorShellComponent },
  { path: '**', redirectTo: 'browse' },
];
