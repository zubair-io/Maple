// Root component — bootstraps mock data into the signal store and mounts the shell.

import { Component, OnInit, inject } from '@angular/core';
import { LibraryStateService, mockLibrary } from '@maple-common';
import { BrowseShellComponent } from './browse-shell/browse-shell.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [BrowseShellComponent],
  template: `<browse-shell />`,
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
