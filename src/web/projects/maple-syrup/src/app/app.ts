// Root component — Hosted variant. Wraps the router-outlet in
// RootShellComponent so the phone-tier vs pane-tier shell switch (driven
// by LayoutService.layout()) happens at the root. No mock data; the
// library is empty until the user picks a photo or a folder from the
// landing page.
//
// Responsive-program S1a (#597). Deep-link cold-boot dispatch added
// in #624 — see DeepLinkService.

import { Component, inject, OnInit } from '@angular/core';
import { DeepLinkService, LibraryStateService, RootShellComponent } from '@maple-common';

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

  constructor() {
    // Cold-boot deep-link dispatch. Same shape as the Self-Hosted
    // app (see projects/maple/src/app/app.ts). The PWA protocol
    // handler expands `maple://image/{id}` to
    // `/library/editor/<encoded maple://…>`; DeepLinkService
    // unwraps that internally. Silent fallback per spec §2.
    if (typeof window === 'undefined') return;
    const href = window.location.href;
    if (href.startsWith('maple://') || /[?&](image|source|url)=/.test(href)) {
      inject(DeepLinkService).resolve(href);
    }
  }

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
