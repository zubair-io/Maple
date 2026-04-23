import { Routes } from '@angular/router';
import { BrowseShellComponent, EditorShellComponent } from '@maple-common';
import { LandingComponent } from './landing/landing.component';

// Hosted: `/` is the Landing page with two CTAs. Users enter Browse or the
// Editor explicitly from there.
export const routes: Routes = [
  { path: '', component: LandingComponent },
  { path: 'browse', component: BrowseShellComponent },
  { path: 'edit/:id', component: EditorShellComponent },
  { path: '**', redirectTo: '' },
];
