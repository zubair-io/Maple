import { Routes } from '@angular/router';
import { BrowseShellComponent, EditorShellComponent } from '@maple-common';

// Self-Hosted: the server already hosts the library, so the root path goes
// straight to /browse. No landing page.
export const routes: Routes = [
  { path: '', redirectTo: 'browse', pathMatch: 'full' },
  { path: 'browse', component: BrowseShellComponent },
  { path: 'edit/:id', component: EditorShellComponent },
  { path: '**', redirectTo: 'browse' },
];
