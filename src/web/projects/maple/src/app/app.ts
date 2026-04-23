// Root component — bootstraps mock data into the signal store and mounts the router outlet.
// P7: Single SPA — router handles /browse and /edit/:id within one Angular app.

import { Component, OnInit, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { LibraryStateService, mockLibrary } from '@maple-common';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet],
  template: `<router-outlet/>`,
  styles: [`:host { display: block; }`],
})
export class App implements OnInit {
  private state = inject(LibraryStateService);

  ngOnInit(): void {
    const { assets, sidebarTree } = mockLibrary();
    this.state.assets.set(assets);
    this.state.sidebarTree.set(sidebarTree);
    // Default selection: France trip folder (has mock assets).
    this.state.selectedSourceId.set('f-france');
    // Default focus: first asset.
    if (assets.length > 0) {
      this.state.selectAsset(assets[0].id);
    }
  }
}
