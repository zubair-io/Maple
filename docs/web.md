# Web (Angular workspace)

`src/web/` is one Angular 21 workspace that produces two single-page apps from one shared library. **`maple`** is the Self Hosted client: it talks to the Bun API over `/api`, requires sign-in, and is served as static files by the API itself. **`maple-syrup`** is the Hosted client: browser-only, no server, no account — it opens files and folders through the File System Access API and does everything locally. Both mount the same shells, components, editor and XMP code from **`maple-common`**, and both run the full Rust RAW pipeline in the browser: a Web Worker loads the `raw-wasm` bundle and renders either through WebGPU (a persistent GPU session presenting straight to an `OffscreenCanvas`) or through the WASM-CPU fallback. Which of the two apps you get is decided by a handful of injection tokens provided at each app's composition root; everything else is shared code.

## The two apps

|                       | `maple` (Self Hosted)                               | `maple-syrup` (Hosted)                                |
| --------------------- | --------------------------------------------------- | ----------------------------------------------------- |
| Source root           | `src/web/projects/maple/`                           | `src/web/projects/maple-syrup/`                       |
| Dev port              | 4201 (`ng serve maple`)                             | 4200 (`ng serve maple-syrup`)                         |
| Library source        | `HttpLibrarySource` → Bun API                       | `FsAccessLibrarySource` → File System Access API      |
| Root route            | redirects to `/browse`                              | Landing page with "open photo" / "open folder"        |
| Auth                  | `authGuard` on every content route                  | none — no auth surface exists                         |
| Service worker config | `ngsw-config.json` (adds API data caches)           | `ngsw-config.hosted.json` (app shell only)            |
| Build output          | `dist/maple/browser/`, served by the API            | `dist/maple-syrup/browser/`, uploaded to blob storage |
| Dev proxy             | `projects/maple/proxy.conf.json` → `localhost:3000` | none                                                  |

The fork happens in each app's `app.config.ts` via `provideSelfHostedWorkspace()` / `provideHostedWorkspace()` (`projects/maple-common/src/lib/workspace/`). Those set `LIBRARY_BACKEND` (`'self-hosted' | 'hosted'`), pick the `LIBRARY_SOURCE` implementation, and — for Self Hosted only — wire capability tokens for asset rename, drag-move, trash, folder CRUD and batch rename. Hosted provides `null` for the server-side tokens, so the components that depend on them never activate and the services behind them never enter Hosted's import graph.

### Routes

Self Hosted (`projects/maple/src/app/app.routes.ts`) has `/browse/:slug/**`, `/edit/:slug/**` (the canvas-first editor), `/view/:slug/**` (a fast static-image preview with no canvas or WASM), `/search`, `/sign-in`, `/join`, and a lazily loaded `/settings/*` family: `account`, `users`, `workers`, `sources`, `imports`, `people` (plus `people/hidden`, `people/excluded`, `people/:id`), `pano`, `map`, `network`, `observability`, `cloudflare`. Older URLs (`/library`, `/people`, `/settings/enrichment`, `/settings/backup`, `/search/advanced`) are router-level redirects, not HTTP redirects.

Hosted has the same `browse` / `edit` / `view` triple plus the landing page and `/maple-ui`. It has no search, settings or auth routes at all.

Both apps register `/protocol-handler`, declared in their `manifest.webmanifest`: the browser rewrites a `web+maple://…` link into `?url=…`, and `ProtocolHandlerComponent` decodes it back into a canonical Angular route. Self Hosted adds `/open-file`, where Chromium lands when the installed PWA is chosen from the OS "Open with" menu, handing the picked files over through `window.launchQueue`.

### The Maple UI gallery page

Hosted serves the design-system catalog at `/maple-ui` (`projects/maple-syrup/src/app/maple-ui-page/`). Token tables render live from the codegen-generated `MAPLE_UI_*` tables; the per-component contract cards render the actual markdown from `docs/design/maple-ui/components/*.md`. Those files are **not** listed in `angular.json` — they are copied into `projects/maple-syrup/public/assets/maple-ui-docs/` (plus a generated `manifest.json`) by `scripts/sync-maple-ui-docs.mjs`, which runs from the `prestart:syrup` / `prebuild:syrup` hooks. The copies are gitignored build artifacts; `bun run maple-ui:check` verifies they match the source. `MapleUiDocsService` fetches the manifest and then each `.md` at runtime. See [unified-component-catalog](unified-component-catalog.md).

## `maple-common`

Everything reusable lives in `projects/maple-common/src/lib/` and is re-exported from `public-api.ts` under the `@maple-common` path alias. The top-level areas:

| Area                                                                                                                                                                                                                                                   | What's in it                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shells/`                                                                                                                                                                                                                                              | `BrowseShellComponent`, `EditorShellComponent`, `PreviewShellComponent`, `RootShellComponent`, protocol/file-handler landing components                          |
| `ui/`                                                                                                                                                                                                                                                  | The Maple UI design system — ~156 `mui-*` component directories, atoms through pages                                                                             |
| `components/`                                                                                                                                                                                                                                          | Feature components: `asset-grid`, `image-canvas`, `filmstrip`, `folder-tree`, `crop-overlay`, `develop`, `scopes`, `map-view`, `timeline-view`, `library-picker` |
| `editor/`                                                                                                                                                                                                                                              | Editor state service, tool model, sub-params, presets, copy/paste of adjustments                                                                                 |
| `state/`                                                                                                                                                                                                                                               | `LibraryStateService`, `LibraryStoreService`, thumbnail queue and caches, selection, timeline state                                                              |
| `api/`                                                                                                                                                                                                                                                 | `BunApiBackendService` and the per-domain HTTP services (workers, trash, imports, pano, map, people, search, Cloudflare)                                         |
| `auth/`                                                                                                                                                                                                                                                | `AuthService` (WebAuthn passkeys), `authInterceptor`, `authGuard`, bootstrap providers                                                                           |
| `addressing/`                                                                                                                                                                                                                                          | `MapleAddress` (`slug:relPath`), Maple-ID hashing and cache, library slug registry, the two `LIBRARY_SOURCE` implementations                                     |
| `raw-pipeline/`                                                                                                                                                                                                                                        | The render worker, its service facade, WASM init, GPU gate, image utilities                                                                                      |
| `xmp/`                                                                                                                                                                                                                                                 | Parser, serializer, canonical writer, passthrough, sidecar store and IndexedDB cache                                                                             |
| `maple-cache/`                                                                                                                                                                                                                                         | The `.maple/` folder cache protocol (index, thumbs, previews) used by Hosted                                                                                     |
| `workspace/`                                                                                                                                                                                                                                           | The Hosted / Self Hosted provider sets and capability policy                                                                                                     |
| `styles/`, `tokens.scss`, `pro-tokens.scss`, `motion.scss`, `safe-area.scss`, `fonts.scss`                                                                                                                                                             | Tailwind theme, generated tokens, shared chrome classes                                                                                                          |
| `generated/`                                                                                                                                                                                                                                           | Codegen output from `raw-core` — adjustment model, adjustment tables, color matrices, film catalog, UI tokens (`.ts` and `.scss`)                                |
| `folder-access/`, `film/`, `export/`, `pano/`, `map/`, `info/`, `search/`, `trash/`, `rename/`, `batch-rename/`, `batch-metadata/`, `drag-move/`, `library/`, `network/`, `observability/`, `sw/`, `util/`, `models/`, `data/`, `icons/`, `deep-link/` | Smaller feature and support areas                                                                                                                                |

Every committed editor action in `editor/` is one `EditTransaction` (`editor/edit-transaction.ts`), the hand-mirror of Apple's `EditTransaction.swift`: a per-binding id, the action class (`adjustment`, `auto`, `crop`, `paste`, `preset`, `reset`, plus `mask` / `repair` / `variant` reserved), a user-visible description, the semantic before/after model, a deterministic sidecar diff (canonical XMP attribute keys and values from `XmpSerializerService.modelAttributes`, omit-on-default on both platforms), and the render-invalidation scope (`crop` / `develop` / `decode`). `EditorStateService.commit(kind, description)` opens one, `LibraryStateService.updateAdjustment` ticks are previews, and `endEdit()` — from `endGesture()`, from every discrete edit, or lazily at the next boundary (`commit`, `undo`, `redo`, `bind`) — closes it: a no-op is dropped, anything else is exactly one entry on the 32-deep ring, is handed to the library as the state the sidecar persists, and is announced through the CDK `LiveAnnouncer`. `edit-transaction.spec.ts` pins the diff and wire format byte-equal to Apple's `EditTransactionTests`; `editor-state.transactions.spec.ts` pins one entry per action class with a valid redo path.

## Conventions

Angular 21.2, TypeScript 5.9, `strict` plus `strictTemplates` / `strictInjectionParameters` / `strictInputAccessModifiers` (`src/web/tsconfig.json`). Both apps run **zoneless** (`provideZonelessChangeDetection()`), so change detection is driven by signals rather than Zone.js patching. Components are standalone with explicit `imports`, use `input()` / `output()` and signals for state, and keep `.ts` / `.html` / `.scss` in separate files. Route-level code splitting uses `loadComponent`; capability-gated widgets use `@defer` so their chunks stay out of the eager graph. Details and rationale are in [best-practices](best-practices.md).

Styling is **Tailwind v4** through PostCSS (`src/web/postcss.config.json` registers `@tailwindcss/postcss`; each app's `styles.scss` starts with `@use 'tailwindcss'`). `projects/maple-common/src/lib/tokens.scss` holds the `@theme` block, which both registers Tailwind theme values and emits the matching `--color-*` / `--font-*` custom properties at `:root`; the hex values themselves come from `raw_core::ui_tokens` via `generated/_ui-tokens.scss`. The universal reset in each app entrypoint is wrapped in `@layer base` — unlayered, it would outrank every Tailwind utility and silently zero out spacing classes.

`projects/maple-common/src/lib/styles/TAILWIND-CONVERSION.md` is the binding recipe for porting a component off SCSS. Its load-bearing rules: map tokens to utilities via the table there rather than guessing; when two states share a CSS property, resolve the precedence in **one** `computed()` string instead of layering conditional utility classes of equal specificity (Tailwind's emitted order is not a template-level guarantee); keep marker classes that a spec or an external selector asserts on; and remember that bare `text-xs`/`text-sm`/`text-base` also set `line-height`. The only SCSS allowed to remain is `@keyframes` and pseudo-elements that need `content` plus absolute geometry.

## The render worker

`projects/maple-common/src/lib/raw-pipeline/raw-pipeline.worker.ts` is a module Web Worker that owns the WASM instance. `RawPipelineService` (same directory) lazily creates it, assigns each request a numeric id, and resolves the matching promise when the reply arrives. Every decode is off the main thread. The worker handles nine request kinds: `decode`, `develop-non-raw`, `decode-scene-linear`, `open-session`, `render-session`, `close-session`, `set-film-lut`, `auto-adjust`, `export`.

### Two render paths

The **persistent GPU live session** is the fast path. `open-session` transfers an `OffscreenCanvas` into the worker and constructs a wasm-side `WebLiveSession`, which uploads the image once, configures the WebGPU surface, retags it `display-p3`, and presents the first frame. `render-session` re-renders for an edit and presents again — no CPU readback at all. The canvas colour space is never assumed: `WebLiveSession` reads back what the browser actually configured via `getConfiguration()` and reports it (`display-p3`, `srgb`, or `unknown`) on every open and render reply. `set-film-lut` loads or clears the session's film-look grid, taking effect on the next render tick. Only one image is live at a time; `raw-pipeline.session-handler.ts` serializes every session operation on a promise chain, because wasm-bindgen holds a `&mut self` borrow across a render's awaits and a second overlapping call throws "recursive use of an object detected".

The **one-shot decode** path serves everything else, and `raw-pipeline.decode-route.ts` picks between four WASM entries in a fixed precedence:

| Route   | Entry                    | When                                                            |
| ------- | ------------------------ | --------------------------------------------------------------- |
| `gpu`   | `render_bytes_gpu`       | unsized, no film LUT, request opts in, and `'gpu' in navigator` |
| `sized` | `render_bytes_sized`     | a `maxLongEdge` cap was requested                               |
| `film`  | `render_bytes_with_film` | an unsized request carries a film LUT                           |
| `cpu`   | `render_bytes`           | everything else                                                 |

`film` deliberately outranks `gpu`: there is no film-aware one-shot GPU entry, only the persistent session carries a loaded look. If the GPU adapter fails at runtime the worker retries on the CPU through the _sized_ entry at the same default cap the GPU call would have used — an unsized retry would ask for the full sensor and, on a large one, blow the WASM memory ceiling.

`ImageCanvasComponent` drives the sizing. `image-canvas.two-phase.ts` implements the fast/refine scheduler: every adjustment tick renders immediately at viewport resolution (element size × device pixel ratio), coalesced latest-wins with a generation counter dropping superseded results; a 150 ms trailing debounce then refines toward native resolution when zoomed in, and is skipped at fit because the refine target equals the fast target there. On the GPU live path the refine pass is skipped entirely — per-tick cost is just uniforms plus a dispatch. See [zoom](zoom.md).

### Kill switch and fallbacks

`GpuLiveRenderGate` combines a build-time injection token (`GPU_LIVE_RENDER_ENABLED`, default `true`) with a DB-backed operator setting fetched from `GET /api/render/config`. Most restrictive wins: a build providing `false` is unconditionally off, and a browser that has never seen a setting defaults to on. `RenderConfigService` refreshes on startup and polls once a minute, so an operator flip reaches already-open tabs without a reload; the gate is read per request, so the flip lands on the next decode or session open. The last applied value is cached in `localStorage` and read back **synchronously** in the gate's field initializer — that is what makes it a real kill switch: once a browser has seen "off" it starts up off even if the API is unreachable.

Beyond the operator switch, the worker falls back on its own whenever the runtime can't deliver: no `navigator.gpu`, a bundle built without the `gpu` feature (`render_bytes_gpu` and `WebLiveSession` are read off the module namespace with `Reflect.get` and existence-checked, so one build works against both bundles), or a failed `requestAdapter()`. `ImageCanvasGpuPresent` adds a per-session check: after the first GPU present the worker reads the canvas back, and if it is all-black while a scope snapshot succeeded, the present failed — the session is torn down, GPU is skipped for the rest of the page session, and the component reverts to the 2D path with a `GpuFallbackNoticeService` notice.

Because the GPU path never produces CPU-side pixels, the worker reads back a small downsampled RGB snapshot of each presented frame and folds it into the open/render reply so the histogram, waveform, parade and vectorscope have data. A readback miss leaves the scopes on their previous values rather than breaking them.

The other two workers are `embedded-preview.worker.ts` (pulls the camera's embedded JPEG out of a RAW) and `addressing/maple-id-fallback.worker.ts` (content hashing for Maple IDs).

## WASM build and sync

The generated glue at `projects/maple-common/src/lib/raw-pipeline/pkg/` is **gitignored**. Every `*.worker.ts` imports it statically, so `ng serve`, `ng build` and `ng test` all fail with `Could not resolve "./pkg/raw_wasm"` until it exists. Build it from this checkout's own Rust source — never copy a `pkg/` from another worktree, since one built at a different revision can be missing exports the current code imports.

```bash
cd src/raw-pipeline/raw-wasm && bash build.sh
cd ../../web && bash scripts/sync-raw-wasm.sh
```

`build.sh` runs `wasm-pack build --target web --release --features gpu,parallel -Z build-std=panic_abort,std` on the nightly toolchain pinned in `raw-wasm/rust-toolchain.toml`. Both features go into **one** bundle: `gpu` supplies the wgpu/WGSL entries, `parallel` supplies wasm-bindgen-rayon. A plain `wasm-pack build` is not equivalent. The script keeps a `pkg/.build-stamp` and no-ops in well under a second when no Rust source has changed (`--force` or `FORCE_WASM_REBUILD=1` overrides). In `src/web`, `npm run raw-wasm` chains build + sync, and the `prestart` / `prebuild` hooks run it automatically — but there is **no** `pretest` hook, so run it by hand before a test-only session.

`scripts/sync-raw-wasm.sh` copies `pkg/` into `maple-common` and then patches wasm-bindgen-rayon's `workerHelpers.js`. Upstream spawns its thread-pool workers with a relative `new Worker(new URL('./workerHelpers.js', import.meta.url))`. esbuild folds that file into the render-worker chunk and does not rewrite a nested worker's spawn URL, so at runtime it resolves to the server root and 404s in both the dev server and the API's static handler — `initThreadPool` then times out and every session silently falls back to single-threaded. The patch splits the file: the parent half keeps `startWorkers` and spawns an absolute, hash-free `/pkg/workerHelpers.worker.js`, and that separate worker-side entry imports the glue at runtime. Both files are published by the `assets` globs in `angular.json`. The script aborts with a loud error if any of the upstream markers it depends on disappears, so a wasm-bindgen-rayon upgrade can't quietly reland the single-threaded fallback. Because `pkg/` is regenerated on every sync, the patch has to live in the script rather than in a committed edit.

### Cross-origin isolation and threading

Rayon needs `SharedArrayBuffer`, which browsers only allow in a cross-origin-isolated document. That requires `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` on the document and the WASM fetch. They are set in three places: `architect.serve.options.headers` in `angular.json` (both dev servers), the API's `src/api/src/middleware/security-headers.ts` for Self Hosted, and `projects/maple-syrup/public/_headers` for Hosted (which also carries a least-privilege CSP, `nosniff`, `Referrer-Policy: no-referrer`, and a permissions policy disabling camera, microphone, geolocation, sensors, payment and USB).

`raw-wasm-init.ts` and `threading-runtime-policy.ts` then decide whether to start the pool. Threading requires cross-origin isolation _and_ a bundle exporting `initThreadPool`. On Chromium/V8 it additionally requires the `prepare_threaded_heap` pre-grow guard: V8 propagates shared-memory growth to other isolates asynchronously, so a parked Rayon worker can resume on a stale bound and trap during a decode. The guard grows the shared heap once, before any worker isolate exists. If the reservation can't be satisfied within the linked 4 GiB ceiling, threading stays off rather than risking the race. Non-Chromium engines were never subject to it and thread without the guard. Everywhere else — Safari, Firefox, or any host missing the headers — the pipeline runs single-threaded: slower on large RAWs, functionally identical. WebGPU is unaffected by all of this.

## Offline: service worker and IndexedDB

Both apps register `ngsw-worker.js` with `registerWhenStable:30000`, disabled in dev mode. The two configs share four asset groups — the app shell (prefetch), the WASM (`/raw_wasm_bg.wasm` and `/pkg/**`, lazy but prefetched on update), fonts, and images. Self Hosted's `ngsw-config.json` adds two data groups the Hosted config deliberately omits: thumbnails (`/api/fs/thumb`, `/api/assets/*/thumb`, performance strategy, 1500 entries, 30 days) and film LUTs (`/film-luts/*.mlut`, 12 entries, 30 days — the 100 `.mlut` files in `resources/film-luts/` are copied into the build by both apps' asset globs). Library data APIs are never cached, so MongoDB stays authoritative. `AppUpdateService` (`lib/sw/`) watches for a freshly downloaded version, toasts the user, and hard-navigates onto the new build at the next route change.

IndexedDB is used through one small in-house helper, `lib/util/idb.ts` (`openDb` / `reqToPromise` / `txDone`), by: the sidecar cache (`xmp/sidecar-idb-cache.ts`), the film-LUT cache (`film/film-lut-idb-cache.ts`), the observability config cache, the folder-listing cache (`api/folder-listing-cache.ts`), Maple-ID and library-slug registries (`addressing/`), user presets (`editor/presets/user-preset-store.ts`), and three folder-access backends that persist `FileSystemHandle`s so a Hosted user's folder survives a reload. See [caching](caching.md).

## API client and auth

Self Hosted's `provideHttpClient(withFetch(), withInterceptors([authInterceptor]))` is the whole client surface; per-domain services in `lib/api/` sit on top of `BunApiBackendService`. `authInterceptor` attaches `Authorization: Bearer …` to everything except a fixed set of session-bootstrap paths (`/api/auth/bootstrap`, the passkey register/login option and verify pairs, `dev-login`, `refresh`, `logout`) — note that `/api/auth/me`, `/credentials/*` and `/invites/*` _do_ get a bearer, since they are scoped to the signed-in user. On a 401 it calls `AuthService.refresh()` (coalesced per tab, serialized across tabs) and retries only when the refresh actually produced a token; a `rejected` refresh clears the session, while a `transient` one (offline, 5xx, rate limit) preserves it so a network blip doesn't sign the user out.

Sign-in is WebAuthn passkeys via `@simplewebauthn/browser`. For local development and e2e the API exposes `POST /api/auth/dev-login`, gated behind `MAPLE_DEV_AUTH=1` (`src/api/src/routes/auth.ts`); the production e2e harness sets it in `scripts/serve-production-e2e.ts`. `AuthService` will also hand a one-time auth code to a native shell, but only for schemes on an explicit allowlist (`maple-app://`), so an attacker-supplied `?native_callback=` is ignored. Hosted provides no interceptor and no auth service usage at all. Route and payload details are in [server-api](server-api.md); the server side is [api](api.md).

## Build and test

```bash
cd src/web
bun install

bun run start:maple      # Self Hosted at http://localhost:4201 (proxies /api → :3000)
bun run start:syrup      # Hosted at http://localhost:4200
bun run build:maple      # → dist/maple/browser/
bun run build:syrup      # → dist/maple-syrup/browser/
```

Unit tests run on vitest through Angular's `@angular/build:unit-test` builder. There are 424 spec files, 387 of them in the library — so **`ng test maple` does not run the library suite**, and CI runs the two projects as separate jobs. Pass the project name explicitly:

```bash
bun run test Maple-common   # the shared library (note the capital M — it's the angular.json project name)
bun run test maple          # the Self Hosted app
bun run test maple-syrup    # the Hosted app
```

End-to-end tests use Playwright, in two configs. `playwright.config.ts` runs `e2e/*.spec.ts` against a live `ng serve maple-syrup` on Chromium only — the decode path needs the cross-origin-isolation headers the dev server sets. `playwright.production.config.ts` runs `e2e/production/**` against _built_ artifacts in real installed Google Chrome, with two projects (`chrome-hosted` on port 4400, `chrome-self-hosted` on 4401) served by `scripts/serve-production-e2e.ts` or, for the artifact-only subset, by `serve-hosted-update-e2e.ts` and `serve-dist-coep.mjs`.

```bash
bun run e2e                          # dev-server suite
bun run e2e:production                # both production projects
bun run e2e:production:hosted         # or :self-hosted
bun run e2e:production-artifacts      # brand assets, service worker, SW update, welcome intake
```

Storybook is wired against the `maple` project (`.storybook/main.ts`, `bun run storybook` on port 6006, `bun run build-storybook`); it picks up stories from `projects/**/*.stories.ts` in any project and maps `maple-common`'s assets so bundled fonts resolve.

## Gates

| Command                                  | What it enforces                                                                                                                                                                                                                                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run format:check`                   | Prettier over exactly the files the branch changes vs `origin/main`, using the repo-pinned binary and `src/web/.prettierrc` — the same list and command as CI's `format-check` job. `--write` (`bun run format`) fixes instead. There is no lint step for web; Prettier is the only style gate.   |
| `bun run check:hosted-artifact`          | The built Hosted bundle carries the expected icons, local fonts and WASM assets, the security headers in `_headers` match `scripts/hosted-security-header-contract.ts` exactly, and the app shell stays under 8 MB.                                                                               |
| `bun run check:hosted-capabilities`      | No server-only marker (route strings, Self-Hosted-only component selectors, UI labels) appears in any Hosted chunk; guarded source files don't reference forbidden symbols; the Self Hosted composition root still provides its capability tokens; and `main-*.js` stays under an 840 KB ratchet. |
| `bun run maple-ui:adoption-check`        | A raw `<button>` or a `btn-primary`/`btn-ghost` class can't re-enter a directory already migrated to the Maple UI components.                                                                                                                                                                     |
| `bun run brand:check` / `maple-ui:check` | The synced brand assets and component-contract copies match their sources.                                                                                                                                                                                                                        |

`angular.json` also sets production budgets per app: 3 MB warning / 8 MB error on the initial bundle, 8 kB / 16 kB per component stylesheet.

CI (`.github/workflows/web.yml`) runs three jobs on every push and PR with no path filter: `web-build` (builds both apps, then the four artifact/boundary/adoption checks and the production-artifact Playwright subset in installed Chrome), `web-test` (`ng test maple`), and `web-test-common` (`ng test Maple-common`). All three provision nightly Rust plus wasm-pack and build the WASM first, sharing one cargo cache key. Repo-wide gates in `.github/workflows/cross.yml` that also bite here: `format-check`, `file-budget` (400 soft / 600 hard LOC per file), `budget-headroom`, `codegen-drift`, `maple-ui-contracts`, and `fallow-audit-web` (dead code, complexity and duplication over changed files). More in [testing](testing.md).

## Deployment

**Self Hosted** ships as static files inside the API deployment: build `dist/maple/browser/` and let the Bun server's static-UI handler serve it, which is also where the COOP/COEP headers come from.

**Hosted** deploys from `.github/workflows/deploy-hosted.yml` on every push to `main` that touches `src/web/**` or `src/raw-pipeline/**`. The job builds the WASM, runs `bun run build:syrup`, re-runs the artifact and capability checks, then `az storage blob upload-batch`es `dist/maple-syrup/browser` into a container on the `hornbeam` storage account. Uploads overwrite but never delete, so a client mid-session can still fetch chunks of the build it loaded. Only JS and CSS carry a content hash, so the batch is _not_ stamped immutable — `raw_wasm_bg.wasm`, `pkg/*.js` and `assets/**` keep stable names, and pinning them would strand clients on a stale binary. `index.html` and `ngsw*` are re-uploaded with `Cache-Control: no-cache`, because a cached copy of either would strand returning clients on the previous deploy. Deploys never cancel in progress.

Two things the workflow can't do: the container must be configured for SPA fallback (unknown paths → `index.html`, HTTP 200), and `_headers` is a Cloudflare Pages / Netlify convention that Azure Blob ignores — the COOP/COEP, CSP and other headers have to be applied by a transform rule at the public edge. `src/web/DEPLOY.md` covers the per-host static-hosting recipes (Cloudflare Pages, Netlify, Vercel, Apache, nginx), including the SPA fallback rule, the `application/wasm` MIME requirement, and the same no-cache rule for `index.html` and `ngsw.json`.
