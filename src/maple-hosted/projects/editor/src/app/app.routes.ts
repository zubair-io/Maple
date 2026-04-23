import { Routes } from '@angular/router';
import { EditorShellComponent } from './editor-shell/editor-shell.component';

export const routes: Routes = [
  { path: 'edit/:id', component: EditorShellComponent },
  { path: '',         redirectTo: 'edit/first', pathMatch: 'full' },
  { path: '**',       redirectTo: 'edit/first' },
];
