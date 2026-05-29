// Root component — Self-Hosted variant. Wraps the router-outlet in
// RootShellComponent so the phone-tier vs pane-tier shell switch (driven
// by LayoutService.layout()) happens at the root. The folder enumeration
// call lives in BrowseShellComponent so it's gated by the authGuard
// (firing it here would race the guard and 401 on cold boot).
//
// Responsive-program S1a (#597). Deep-link cold-boot dispatch added
// in #624 — see DeepLinkService.

import { Component, inject } from '@angular/core';
import { DeepLinkService, RootShellComponent } from '@maple-common';

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
export class App {
  constructor() {
    // Cold-boot deep-link dispatch. Three shapes are accepted:
    //   • `maple://image/{id}` — direct custom-scheme, e.g. from a
    //     native handler that re-dispatched into the browser.
    //   • `/library/editor/<encoded maple://…>` — what the PWA's
    //     `protocol_handlers` manifest entry expands to: the template
    //     is `/library/editor/%s` (path segment), and `%s` is replaced
    //     with the URL-encoded `maple://…` href. DeepLinkService
    //     unwraps that internally.
    //   • `?image={id}` / `?source={id}` — direct HTTPS query form
    //     for in-app callers that pre-build the route.
    // Silent fallback per spec §2 — bad input never navigates.
    if (typeof window === 'undefined') return;
    const href = window.location.href;
    if (href.startsWith('maple://') || /[?&](image|source)=/.test(href)) {
      inject(DeepLinkService).resolve(href);
    }
  }
}
