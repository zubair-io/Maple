// Root component — bootstraps mock data into the shared LibraryStateService
// and mounts the router outlet. The editor bootstraps its own library data
// so it can run standalone (port 4300). When both apps run together, the
// service is providedIn: 'root' inside each bundle independently; cross-app
// state sync via postMessage or URL params is deferred to a future slice.

import { Component, OnInit, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { LibraryStateService, mockLibrary } from '@maple-common';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet],
  template: `<router-outlet/>`,
})
export class App implements OnInit {
  private state = inject(LibraryStateService);

  ngOnInit(): void {
    // Only seed mock data if the store is empty (prevents double-seeding).
    if (this.state.assets().length === 0) {
      const { assets, sidebarTree } = mockLibrary();
      this.state.assets.set(assets);
      this.state.sidebarTree.set(sidebarTree);
      this.state.selectedSourceId.set('f-france');
      if (assets.length > 0) {
        this.state.selectAsset(assets[0].id);
      }
    }
  }
}
