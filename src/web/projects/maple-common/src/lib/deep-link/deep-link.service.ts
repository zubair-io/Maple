// deep-link.service.ts — resolve `maple://image/{id}` and
// `maple://source/{id}` to an Angular Router navigation, plus the
// PWA `protocol_handlers` delivery shape and the equivalent
// HTTPS query-string fallback. The web app's manifests register
// `/library/editor/%s` (path expansion), so Chromium lands a
// `maple://…` invocation at `/library/editor/<URL-encoded maple://…>`;
// the service unwraps that wrapper below and recurses.
//
// Same routes as Apple — keeps the two platforms shoulder-to-shoulder
// per the spec's "shared DeepLinkResolver" goal:
//
//   • maple://image/{id}                       ↔ /view/{id} (or /view/:slug/** for a slug:relPath id)
//   • maple://source/{id}                      ↔ /library?source={id}
//   • maple://browse/{slug}[/{...relPath}]     ↔ /browse/:slug/**  (M2, #1327)
//   • maple://edit/{slug}/{...relPath}         ↔ /edit/:slug/**    (M2, #1327)
//
// HTTPS deep links also accept bare `?image=…`/`?source=…` query
// params (in-app callers that pre-build the route); those drop
// straight into the resolver without the wrapping step.
//
// Spec: docs/design/responsive-program/deep-links.md §4.
// Closes #624.

import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';

import { viewRouteCommands } from '../addressing/route-address';

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
    // The PWA `protocol_handlers` shim lands `maple://…` invocations at
    // `/library/editor/<encoded maple://…>` (legacy) or `/protocol-handler?url=…`
    // (M2). Support both the legacy segment-based unwrap and the new handler.
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
      this.router.navigate(viewRouteCommands(image));
    } else if (source) {
      this.router.navigate(['/library'], { queryParams: { source } });
    }
  }

  private resolveMapleScheme(u: URL): void {
    // `URL` parses `maple://image/abc` with `hostname = "image"` and
    // `pathname = "/abc"`. We accept both the `pathname` form and a
    // bare host (`maple://image/`) per spec §3 minimum-id check.
    const pathSegs = u.pathname.split('/').filter(Boolean);
    const host = u.hostname;

    if (host === 'image') {
      // Phone-tier route: the id is the full path (may include slug:relPath)
      const id = pathSegs.join('/');
      if (!id) return;
      this.router.navigate(viewRouteCommands(id));
    } else if (host === 'source') {
      const id = pathSegs[0];
      if (!id) return;
      this.router.navigate(['/library'], { queryParams: { source: id } });
    } else if ((host === 'browse' || host === 'edit') && pathSegs.length > 0) {
      // M2 (#1327): path-based browse/edit routes. `pathSegs[0]` is the slug;
      // remaining segments are the relPath parts. Router.navigate accepts an
      // array of segments; it will build `/browse/<slug>/<...rest>` correctly.
      const routeSegs = pathSegs.map((s) => decodeURIComponent(s));
      this.router.navigate(['/' + host, ...routeSegs]);
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
