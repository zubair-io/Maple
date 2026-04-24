// Root component — Hosted variant. No mock data; the library is empty until
// the user picks a photo or a folder from the landing page.

import { Component, inject, OnInit } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { LibraryStateService } from '@maple-common';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet],
  template: `<router-outlet />`,
  styles: [
    `
      :host {
        display: block;
      }
    `,
  ],
})
export class App implements OnInit {
  private state = inject(LibraryStateService);

  ngOnInit(): void {
    // Seed an empty Folders section so addImportedAsset and openFolder can
    // attach their entries — LibraryStateService._ensureFolder is a no-op
    // when the section doesn't exist.
    if (this.state.sidebarTree().length === 0) {
      this.state.sidebarTree.set([
        { kind: 'section', id: 'folders', label: 'Folders', count: null, children: [] },
      ]);
    }
  }
}
