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

| Setting | Value |
|---------|-------|
| Build command | `npm run sync-raw-wasm && ng build maple --configuration=production` |
| Build output directory | `dist/maple/browser` |
| Node.js version | 20+ |

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
  command   = "cd src/maple-hosted && npm run sync-raw-wasm && ng build maple --configuration=production"
  publish   = "src/maple-hosted/dist/maple/browser"

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

## Vercel

Add `vercel.json` at the repo root (or in `src/maple-hosted/`):

```json
{
  "buildCommand": "cd src/maple-hosted && npm run sync-raw-wasm && ng build maple --configuration=production",
  "outputDirectory": "src/maple-hosted/dist/maple/browser",
  "routes": [
    {
      "src": "/raw_wasm_bg\\.wasm",
      "headers": { "Content-Type": "application/wasm" },
      "dest": "/raw_wasm_bg.wasm"
    },
    {
      "handle": "filesystem"
    },
    {
      "src": "/(.*)",
      "dest": "/index.html"
    }
  ]
}
```

The last route is the SPA fallback. `"handle": "filesystem"` ensures static files are served first; unknown paths fall through to `index.html`.

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

## Local production preview

```bash
cd src/maple-hosted
npm run build          # builds to dist/maple/browser/
python3 -m http.server 4200 --directory dist/maple/browser
# open http://localhost:4200
```

Note: `python3 -m http.server` serves `.wasm` as `application/wasm` out of the box on Python 3.4+.
