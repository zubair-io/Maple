# Maple thumbnail-cache Worker

Cloudflare Worker fronting the API server's `GET /api/thumb/*` route with an
R2 edge cache — see the epic at `#1757` and the design ticket `#1760`. This
is a standalone deploy unit: no shared imports with `src/api` or `src/web`.
The R2 object-key scheme and the JWT verification logic are independently
re-implemented here to match `src/api/src/cloudflare/thumb-key.ts` and
`src/api/src/auth/tokens.ts` — keep the two in sync by hand if either
changes.

## Prerequisites

- **Node.js** (not Bun) for `npm test` / `npm run dev` — see below.
- `npm install`

### Why Node, not Bun

Every other Maple subproject uses Bun. This one is npm/Node-only because
`@cloudflare/vitest-pool-workers` bridges the vitest runner and the worker
isolate over a WebSocket, and Bun's WebSocket implementation doesn't fire
the `upgrade` event that bridge depends on — tests hang indefinitely
(`Timeout calling "fetch"`) under `bun x vitest` / `bun run test`. Plain
`wrangler dev` / `wrangler deploy` don't hit this (they don't use the vitest
pool), so only test-running is affected — but for consistency the whole
subproject is npm-based. If your shell's `node` resolves to Bun's node-shim
(`~/.bun/bin/node -> bun`), point `PATH` at a real Node install (or invoke
`/usr/local/bin/node node_modules/.bin/vitest run` directly) before running
tests locally.

## Commands

```bash
cp wrangler.jsonc.example wrangler.jsonc  # first time only — see below
npm install
npm run cf-typegen    # generates worker-configuration.d.ts (Env type) — gitignored,
                       # run this once after install and again after editing wrangler.jsonc
npm run typecheck     # tsc --noEmit
npm test              # vitest run, via @cloudflare/vitest-pool-workers
npm run dev           # wrangler dev — local server at http://localhost:8787
npm run deploy        # wrangler deploy
```

`wrangler.jsonc` is gitignored — it holds account/domain-specific values
(origin URL, R2 bucket name, route pattern) that are per-operator, not
project source. `wrangler.jsonc.example` is the committed template; copy it
once and edit your copy freely, it'll never show up in `git status`.

## First-time setup (per Cloudflare account)

0. `cp wrangler.jsonc.example wrangler.jsonc` if you haven't already.
1. Create the R2 bucket (name must match your `wrangler.jsonc`'s
   `r2_buckets[0].bucket_name`, and the bucket name configured in Maple's
   Settings → Cloudflare page):
   ```bash
   npx wrangler r2 bucket create maple-thumbs
   ```
2. Set the JWT secret. Maple has no UI or API route that echoes it —
   retrieve it directly from the server (MongoDB `server_state` collection,
   `_id: "jwt_secret"`, field `value`; see
   `src/api/src/auth/jwt-secret.repo.ts`):
   ```bash
   npx wrangler secret put JWT_SECRET
   ```
3. Fill in `ORIGIN_API_BASE_URL` in your `wrangler.jsonc` with your deployed
   Maple API server's public URL. If that's the same hostname the route
   below intercepts, read the loop warning in `wrangler.jsonc.example` first.
4. Attach a route so only `/api/thumb/*` traffic reaches this Worker —
   uncomment and fill in the `routes` block in your `wrangler.jsonc` (needs
   a Cloudflare-managed zone). Everything else, including the legacy
   `/api/fs/thumb` path, must keep going straight to the origin.
5. `npm run deploy`.

## CI

`.github/workflows/cloudflare.yml` runs `npm run typecheck` + `npm test` on
every push/PR touching this directory, against a throwaway config generated
from `wrangler.jsonc.example` (fine for typecheck/tests — they don't need
real account values). There is **no auto-deploy job** — `wrangler.jsonc`
being per-operator and gitignored means CI has no real config to deploy
with. Deploy manually with `npm run deploy` whenever you're ready to ship,
using your own local `wrangler.jsonc`.
