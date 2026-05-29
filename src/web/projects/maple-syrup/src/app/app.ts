// Root component — Hosted variant. Wraps the router-outlet in
// RootShellComponent so the phone-tier vs pane-tier shell switch (driven
// by LayoutService.layout()) happens at the root. No mock data; the
// library is empty until the user picks a photo or a folder from the
// landing page.
//
// Responsive-program S1a (#597).

import { Component, inject, OnInit } from '@angular/core';
import { LibraryStateService, RootShellComponent } from '@maple-common';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RootShellComponent],
  template: `<app-root-shell />`,
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
