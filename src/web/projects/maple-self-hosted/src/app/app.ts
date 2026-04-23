// Root component — bootstraps mock data into the signal store and mounts the
// router outlet. Self-Hosted variant: talks to the Bun API.

import { Component, OnInit, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { LibraryStateService, mockLibrary } from '@maple-common';

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
    // TODO(T4-self-hosted-backend): replace mockLibrary() with a call to
    // BunApiBackendService.listFolders() + listAssets() once the state
    // service is fully swapped over.
    const { assets, sidebarTree } = mockLibrary();
    this.state.assets.set(assets);
    this.state.sidebarTree.set(sidebarTree);
    this.state.selectedSourceId.set('f-france');
    if (assets.length > 0) {
      this.state.selectAsset(assets[0].id);
    }
  }
}
