// protocol-handler.component.ts — PWA polish (#620).
//
// Landing route for the manifest `protocol_handlers` entry. The browser
// substitutes the entire invoked URL (e.g. `web+maple://image/abc123`)
// into the `%s` placeholder, percent-encoded, so we register
// `/protocol-handler?url=%s` in the manifest and decode the URL here
// before redirecting to the canonical Angular route.
//
// Accepts both the W3C-required `web+maple` prefix used by the Chromium
// `protocol_handlers` field and the bare `maple` scheme that the iOS app
// registers (per the deep-links spec referenced in pwa-polish.md §3); the
// future deep-link service will normalise both forms.
//
// Supported targets:
//   web+maple://image/<id>            →  /view/<id>
//   maple://image/<id>                →  /view/<id>
//   maple://browse/<slug>[/<relPath>] →  /browse/:slug/**  (M2, #1327)
//   maple://edit/<slug>/<relPath>     →  /edit/:slug/**    (M2, #1327)
//
// Anything malformed (missing param, non-maple scheme, unknown host) falls
// back to `/library` rather than throwing, so an attacker can't pivot off
// a crafted protocol URL into a router error.

import { ChangeDetectionStrategy, Component, inject, OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';

@Component({
  selector: 'app-protocol-handler',
  standalone: true,
  template: `<p>Opening Maple…</p>`,
  styles: [
    `
      :host {
        display: block;
        padding: 24px;
        color: var(--mpl-text-secondary, #a8a29e);
        font-size: 13px;
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProtocolHandlerComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  ngOnInit(): void {
    const raw = this.route.snapshot.queryParamMap.get('url');
    const target = parseProtocolUrl(raw) ?? ['/library'];
    void this.router.navigate(target, { replaceUrl: true });
  }
}

/**
 * Parse a `web+maple://…` or `maple://…` URL into the Angular route segments
 * it should redirect to. Returns `null` if the URL is missing, malformed, or
 * uses an unsupported scheme/host so the caller can fall back to a safe
 * default. Exported for unit tests.
 */
export function parseProtocolUrl(raw: string | null): string[] | null {
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  // `URL` keeps the colon: protocol `'web+maple:'` / `'maple:'`.
  const scheme = parsed.protocol.replace(/:$/, '');
  if (scheme !== 'maple' && scheme !== 'web+maple') return null;

  // For `web+maple://image/abc`, hostname = 'image', pathname = '/abc'.
  // M2 (#1327): `maple://browse/<slug>/...` and `maple://edit/<slug>/...`
  // map to the path-based Angular routes `/browse/:slug/**` and `/edit/:slug/**`.
  const host = parsed.hostname;
  // pathname = '/slug/segment1/segment2/...' → split and filter empties
  const pathSegs = parsed.pathname.split('/').filter(Boolean);

  if (host === 'image' && pathSegs.length > 0) {
    return ['/view', decodeURIComponent(pathSegs.join('/'))];
  }

  if ((host === 'browse' || host === 'edit') && pathSegs.length > 0) {
    // slug is pathSegs[0]; remaining segments are the relPath parts.
    // Each segment is separately decoded so percent-encoded slashes in
    // individual names are preserved as-is across the router segments.
    const routeSegs = pathSegs.map((s) => decodeURIComponent(s));
    return ['/' + host, ...routeSegs];
  }

  return null;
}
