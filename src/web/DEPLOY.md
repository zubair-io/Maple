# Maple — Production Deploy Guide

Maple is a single-page Angular application. The production build lives in `dist/maple/browser/` after running:

```bash
npm run sync-raw-wasm           # copies raw_wasm_bg.wasm into the pkg/ directory
ng build maple --configuration=production
# or: npm run build
```

Output: `dist/maple/browser/` with hash-named JS/CSS bundles, `raw_wasm_bg.wasm`,
`ngsw-worker.js`, `ngsw.json`, `index.html`, `manifest.webmanifest`.

---

## Requirements for every host

1. **SPA fallback** — unknown paths (`/browse`, `/edit/:id`) must return `index.html` with HTTP 200 (not 404).
2. **WASM MIME type** — `raw_wasm_bg.wasm` must be served as `application/wasm`. Most hosts handle this automatically; see per-host notes below.
3. **Service worker scope** — serve from the root path `/`. Sub-path deployments require adjusting `<base href>` in `index.html` and the `ngsw-config.json` paths.

---

## Cloudflare Pages

**Build settings** (in the Pages dashboard or `wrangler.toml`):

| Setting                | Value                                                                |
| ---------------------- | -------------------------------------------------------------------- |
| Build command          | `npm run sync-raw-wasm && ng build maple --configuration=production` |
| Build output directory | `dist/maple/browser`                                                 |
| Node.js version        | 20+                                                                  |

**SPA fallback** — Cloudflare Pages automatically serves `index.html` for 404s on static sites. No extra config needed.

**WASM MIME type** — Cloudflare Pages serves `.wasm` as `application/wasm` by default.

**Optional headers file** — add `dist/maple/browser/_headers` (or `public/_headers` in your repo root) to set explicit headers:

```
/raw_wasm_bg.wasm
  Content-Type: application/wasm

/*
  X-Frame-Options: SAMEORIGIN
  X-Content-Type-Options: nosniff
```

---

## Netlify

Add `netlify.toml` at the repo root:

```toml
[build]
  command   = "cd src/web && npm run sync-raw-wasm && ng build maple --configuration=production"
  publish   = "src/web/dist/maple/browser"

[[redirects]]
  from   = "/*"
  to     = "/index.html"
  status = 200

[[headers]]
  for = "/raw_wasm_bg.wasm"
  [headers.values]
    Content-Type = "application/wasm"
```

The `[[redirects]]` block is the SPA fallback — all unmatched routes return `index.html` with HTTP 200.

---

## Plain static host (Apache / nginx)

### Apache `.htaccess`

Place in the document root (same folder as `index.html`):

```apache
# SPA fallback
<IfModule mod_rewrite.c>
  RewriteEngine On
  RewriteBase /
  RewriteRule ^index\.html$ - [L]
  RewriteCond %{REQUEST_FILENAME} !-f
  RewriteCond %{REQUEST_FILENAME} !-d
  RewriteRule . /index.html [L]
</IfModule>

# WASM MIME type (if not already set by server)
<IfModule mod_mime.c>
  AddType application/wasm .wasm
</IfModule>
```

### nginx server block

```nginx
server {
  listen 80;
  root /var/www/maple;
  index index.html;

  # WASM MIME type
  types {
    application/wasm wasm;
  }

  # SPA fallback — all unknown paths serve index.html
  location / {
    try_files $uri $uri/ /index.html;
  }

  # Cache static assets aggressively (they have content hashes)
  location ~* \.(js|css|wasm|png|jpg|webp|svg|ico|woff2)$ {
    expires 1y;
    add_header Cache-Control "public, immutable";
  }

  # Do not cache index.html or service worker files
  location ~* (index\.html|ngsw\.json|ngsw-worker\.js)$ {
    expires -1;
    add_header Cache-Control "no-store, no-cache, must-revalidate";
  }
}
```

---

## Service Worker notes

- The service worker (`ngsw-worker.js`) is only registered in production mode (`isDevMode()` is false).
- On first visit the worker prefetches the app shell (HTML/JS/CSS). WASM and assets are lazily cached.
- To force clients to pick up a new version after re-deploy, the service worker checks `ngsw.json` on startup; a changed hash triggers background update + prompt.
- During local dev (`ng serve`), the service worker is disabled automatically — no interference.

---

## Hosted production security policy

The RAW decode path ships a `wasm-bindgen-rayon` thread pool that only
activates inside a **cross-origin-isolated** document. Browsers require two
response headers on every top-level document and every subresource:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Without these, Safari and Firefox default to single-threaded decode and
Chrome refuses `SharedArrayBuffer`. The JS wrapper detects
`crossOriginIsolated` and degrades gracefully — the app still loads and
renders, just slower on large RAWs.

### Cloudflare Pages / Netlify

Both hosts honour the `_headers` file that ships in
`projects/maple-syrup/public/_headers`. After `ng build maple-syrup` the
file lands in `dist/maple-syrup/browser/_headers` and is picked up
automatically — no extra config needed. The artifact checker compares that file
with `scripts/hosted-security-header-contract.ts`, the same contract imported by
the local production-artifact server. It includes COOP/COEP, a least-privilege
CSP, `nosniff`, no-referrer, and disabled unused browser permissions.

Azure Blob Storage does not interpret `_headers`. The Cloudflare/Azure edge must
apply the same response headers before public deployment can be qualified; that
work is deliberately tracked in Milestone 20 issue #2474.

### Apache / nginx

Apache (`.htaccess`):

```apache
<IfModule mod_headers.c>
  Header set Cross-Origin-Opener-Policy "same-origin"
  Header set Cross-Origin-Embedder-Policy "require-corp"
</IfModule>
```

nginx:

```nginx
add_header Cross-Origin-Opener-Policy "same-origin" always;
add_header Cross-Origin-Embedder-Policy "require-corp" always;
```

### Bun API (`maple`)

The Bun server already emits both headers from `src/api/src/index.ts`
(`onBeforeHandle`) and from the static-UI handler in
`src/api/src/routes/static_ui.ts`. No deployer config needed.

### Angular dev server

`src/web/angular.json` sets the headers on `architect.serve.options.headers`
for both apps, so `npm run start:syrup` and `npm run start:maple`
already serve cross-origin-isolated responses — threading works locally.

---

## Local production preview

```bash
cd src/web
npm run build:syrup
DIST=dist/maple-syrup/browser PORT=4200 bun scripts/serve-dist-coep.mjs
# open http://127.0.0.1:4200
```

This server imports the production security contract directly. A generic static
server does not provide equivalent CSP, isolation, or hardening headers and is
not a valid production qualification surface.
