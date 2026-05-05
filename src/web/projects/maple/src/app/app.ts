// Root component — Self-Hosted variant. Pure router-outlet wrapper; the
// folder enumeration call lives in BrowseShellComponent so it's gated by
// the authGuard (firing it here would race the guard and 401 on cold boot).

import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet],
  template: `<router-outlet />`,
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
