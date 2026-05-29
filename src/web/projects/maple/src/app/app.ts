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
    //   • `maple://image/{id}` — set when the PWA's protocol_handler
    //     fires (Chromium); the registration template lands the URL
    //     as `?url=maple%3A%2F%2F…` against the browser tab.
    //   • `?image={id}` / `?source={id}` — direct HTTPS form.
    //   • `/library/editor/<encoded maple://…>` — PWA expansion of
    //     the `%s` template, unwrapped inside the service.
    // Silent fallback per spec §2 — bad input never navigates.
    if (typeof window === 'undefined') return;
    const href = window.location.href;
    if (href.startsWith('maple://') || /[?&](image|source|url)=/.test(href)) {
      inject(DeepLinkService).resolve(href);
    }
  }
}
