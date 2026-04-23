import { Routes } from '@angular/router';
import { BrowseShellComponent } from '@maple-common';
import { EditorShellComponent } from '@maple-common';

export const routes: Routes = [
  { path: '', redirectTo: 'browse', pathMatch: 'full' },
  { path: 'browse', component: BrowseShellComponent },
  { path: 'edit/:id', component: EditorShellComponent },
  { path: '**', redirectTo: 'browse' },
];
