// library-page.component.ts — responsive-program S2 (#623). Route
// component for `/library` on the Hosted shell. Thin wrapper around
// the shared `<app-library-grid>` so the routing layer in this app
// stays free of layout details.

import { ChangeDetectionStrategy, Component } from '@angular/core';
import { LibraryGridComponent } from '@maple-common';

@Component({
  selector: 'app-library-page',
  standalone: true,
  imports: [LibraryGridComponent],
  template: '<app-library-grid />',
  styles: [':host { display: block; min-height: 100%; }'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LibraryPageComponent {}
