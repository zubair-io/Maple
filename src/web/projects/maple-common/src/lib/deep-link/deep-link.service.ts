// deep-link.service.ts — resolve `maple://image/{id}` and
// `maple://source/{id}` to an Angular Router navigation, plus the
// equivalent HTTPS query-string forms a PWA `protocol_handlers`
// registration delivers (Chromium dispatches `?url=maple://…` against
// the registered template, which lands here as `?image=…`/`?source=…`).
//
// Same routes as Apple — keeps the two platforms shoulder-to-shoulder
// per the spec's "shared DeepLinkResolver" goal:
//
//   • maple://image/{id} ↔ /library/editor/{id}
//   • maple://source/{id} ↔ /library?source={id}
//
// HTTPS deep links land at `/library?image=…` or `/library?source=…`
// via the `url` template; the equivalent `image=`/`source=` query
// params drop straight into the resolver.
//
// Spec: docs/design/responsive-program/deep-links.md §4.
// Closes #624.

import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';

@Injectable({ providedIn: 'root' })
export class DeepLinkService {
  private router = inject(Router);

  /**
   * Resolve a deep-link URL (custom-scheme or HTTPS query form) to an
   * Angular Router navigation. Silent no-op for shapes that don't
   * match — never throws, never surfaces an error UI. Per spec §2
   * silent-fallback contract.
   */
  resolve(url: string | URL): void {
    const u = this.parseURL(url);
    if (!u) return;

    if (u.protocol === 'maple:') {
      this.resolveMapleScheme(u);
      return;
    }

    // HTTPS form (PWA `protocol_handlers` shim, or in-app fallback).
    // The PWA registration lands at `/library/editor/%s` per the
    // manifest — `%s` is URL-encoded, so a `maple://image/abc` opens
    // `https://…/library/editor/maple%3A%2F%2Fimage%2Fabc`. `URL`
    // keeps the colon + slashes percent-encoded inside `pathname`,
    // so we decode the last segment first and check for a `maple://`
    // prefix before re-resolving.
    const segs = u.pathname.split('/').filter(Boolean);
    if (segs.length === 3 && segs[0] === 'library' && segs[1] === 'editor') {
      try {
        const inner = decodeURIComponent(segs[2]);
        if (inner.startsWith('maple://')) {
          this.resolve(inner);
          return;
        }
      } catch {
        // Decoding can throw on malformed input — fall through to the
        // raw-query path below so we still try the search-string forms.
      }
    }

    const image = u.searchParams.get('image');
    const source = u.searchParams.get('source');
    if (image) {
      this.router.navigate(['/library/editor', image]);
    } else if (source) {
      this.router.navigate(['/library'], { queryParams: { source } });
    }
  }

  private resolveMapleScheme(u: URL): void {
    // `URL` parses `maple://image/abc` with `hostname = "image"` and
    // `pathname = "/abc"`. We accept both the `pathname` form and a
    // bare host (`maple://image/`) per spec §3 minimum-id check.
    const parts = u.pathname.split('/').filter(Boolean);
    const host = u.hostname;
    const id = parts[0];
    if (!id) return;

    if (host === 'image') {
      this.router.navigate(['/library/editor', id]);
    } else if (host === 'source') {
      this.router.navigate(['/library'], { queryParams: { source: id } });
    }
  }

  private parseURL(url: string | URL): URL | null {
    if (url instanceof URL) return url;
    try {
      // `maple://...` is a valid absolute URL; HTTPS forms relative
      // to the document origin resolve via the second arg. The base
      // is only used when `url` doesn't already have a scheme.
      const base = typeof location !== 'undefined' ? location.origin : 'http://localhost/';
      return new URL(url, base);
    } catch {
      return null;
    }
  }
}
