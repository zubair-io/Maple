# Maple Hosted SSR Worker

Cloudflare Worker fronting the production Maple Hosted domain
(`mapleaperture.com`) with the Azure Blob Storage origin that
`.github/workflows/deploy-hosted.yml` uploads `dist/maple-syrup/browser`
into — see the production-blocker writeup at `#2474`. This is a standalone
deploy unit: no shared imports with `src/api` or `src/web` (same convention
as the sibling thumbnail-cache Worker one level up).

## What it does, and why it exists

Azure Blob Storage has no SPA-fallback or custom-header support of its own —
`projects/maple-syrup/public/_headers` (the Cloudflare Pages / Netlify
convention that would normally carry the production security policy) is
inert there. Before this Worker existed, the production domain was fronted
by a Worker created through the Cloudflare dashboard's Quick Edit UI —
outside source control, undocumented, and broken in several ways the ticket
above catalogs: it served `index.html` for `/raw_wasm_bg.wasm` (its static
allowlist excluded `.wasm`), it called `.text()` on nearly every upstream
response (corrupting binary content — WOFF2, PNG, WASM), it forced every
response to status 200, it stamped a one-year immutable cache policy onto
stable-named files (so a fixed WASM binary would never reach an already-
served client), and it omitted the COOP/COEP headers the RAW decode path's
cross-origin isolation depends on.

This Worker (`src/index.ts`) replaces it with five rules, each one directly
undoing one of those failures:

1. Fetch the requested path from the origin and stream the body straight
   through — never decode it as text.
2. Origin 404 + the request is an HTML navigation → re-fetch and serve
   `/index.html` with status 200 (the SPA fallback). A non-navigation 404
   (a missing JS chunk, a stale asset URL) passes through as a real 404.
3. Correct successful WASM/WOFF2 responses to `application/wasm` /
   `font/woff2` when Azure reports octet-stream. Origin error MIME types
   and status codes pass through unchanged.
4. Never invent a `Cache-Control` — pass the origin's own value through
   untouched. `index.html` requests routed through the fallback path get an
   explicit `no-cache`, matching the same rule the upload step in
   `deploy-hosted.yml` applies to the origin object directly.
5. Apply the production security header contract
   (`src/security-headers.ts`, mirroring
   `src/web/scripts/hosted-security-header-contract.ts`) to every response,
   and strip Azure's own `x-ms-*`/`Server` implementation-detail headers.

## Prerequisites

Same as the sibling thumbnail-cache Worker: **Node.js**, not Bun, for
`npm test` (`@cloudflare/vitest-pool-workers` needs a real WebSocket
`upgrade` event that Bun's implementation doesn't fire) — see
`../README.md` § "Why Node, not Bun" for the full explanation.

## Commands

```bash
cp wrangler.jsonc.example wrangler.jsonc  # first time only
npm install
npm run cf-typegen    # generates worker-configuration.d.ts (Env type) — gitignored
npm run typecheck     # tsc --noEmit
npm test              # vitest run, via @cloudflare/vitest-pool-workers
npm run dev           # wrangler dev — local server at http://localhost:8787
npm run deploy        # wrangler deploy
npm run smoke -- https://mapleaperture.com https://hornbeam.blob.core.windows.net/mapleaperture
CF_API_TOKEN=... CF_ZONE_ID=... npm run purge  # evict stale edge cache after a deploy
```

`wrangler.jsonc` is gitignored — it holds the account/domain-specific route
and zone. `wrangler.jsonc.example` is the committed template.

## First-time setup (per Cloudflare account)

0. `cp wrangler.jsonc.example wrangler.jsonc` if you haven't already.
1. Fill in `ORIGIN_BASE_URL` in your `wrangler.jsonc` with the public base
   URL of the Azure Blob Storage container `deploy-hosted.yml` uploads into
   (account `hornbeam`, container `mapleaperture` as of this writing).
2. Attach the production route — uncomment and fill in the `routes` block
   in your `wrangler.jsonc` (needs a Cloudflare-managed zone for the
   domain).
3. `npm run deploy`.
4. Run the smoke check against the live domain:
   `npm run smoke -- https://mapleaperture.com`. It compares full SHA-256 hashes of WASM, PNG, WOFF2 and `ngsw.json`
   against the Azure origin (the optional second URL argument defaults to
   `hornbeam/mapleaperture`). It checks MIME/magic, security headers on
   root/assets/deep links, rejects immutable stable assets, requires
   `no-cache` on the service-worker manifest, validates SPA fallback, and
   requires a real 404 for missing subresources. Each fetch has a 60-second
   deadline. Run against a settled deployment: a build changing between
   origin and edge fetches fails the comparison and must be checked again
   after upload completes. `npm test` exercises the CLI against real local
   HTTP servers, including same-length byte corruption, before Worker tests.
5. Purge the edge cache so no client keeps being served a response cached
   under the old, broken Worker:
   `CF_API_TOKEN=... CF_ZONE_ID=... npm run purge`. Required once after the
   first deploy of this Worker; recommended after any deploy where response
   headers or status codes changed (a plain content-only redeploy of
   `dist/maple-syrup/browser` does not need it, since asset URLs are
   content-hashed or explicitly `no-cache`).

## What this Worker deliberately does not do

- **No caching layer of its own.** Unlike the thumbnail-cache Worker, this
  one has no R2/KV binding — it is a pure streaming proxy. Edge caching is
  Cloudflare's normal zone-level cache, driven by whatever `Cache-Control`
  the origin sets (see rule 4 above).
- **No automated CI deploy job.** `wrangler.jsonc` is per-operator and
  gitignored, same as the sibling Worker — `.github/workflows/cloudflare.yml`
  only typechecks and tests this Worker against a throwaway config generated
  from the example file. Deploy manually with `npm run deploy` from your own
  machine, then run the smoke check and purge above.
- **In-browser validation** (fresh/warm Chrome, offline behavior, the
  writable-folder XMP flow, console/network cleanliness) is a separate,
  manual step against the deployed domain — see the remaining checklist in
  `#2474`.
