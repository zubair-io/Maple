// Root component — Self-Hosted variant. Wraps the router-outlet in
// RootShellComponent so the phone-tier vs pane-tier shell switch (driven
// by LayoutService.layout()) happens at the root. The folder enumeration
// call lives in BrowseShellComponent so it's gated by the authGuard
// (firing it here would race the guard and 401 on cold boot).
//
// Responsive-program S1a (#597).

import { Component } from '@angular/core';
import { RootShellComponent } from '@maple-common';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RootShellComponent],
  template: `<app-root-shell />`,
  styles: [
    `
      :host {
        display: block;
        height: 100%;
      }
    `,
  ],
})
export class App {}
