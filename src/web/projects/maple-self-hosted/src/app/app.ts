// Root component — Self-Hosted variant. Kicks off folder enumeration against
// the Bun API on bootstrap. No mock data, no FS Access landing page.

import { Component, OnInit, inject } from '@angular/core';
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
    // Ask the API for folders; state service populates the sidebar + grid
    // and surfaces loading / error / empty states via its signals, which the
    // BrowseShell renders as banners.
    this.state.loadFolderTree();
  }
}
