# Coding Standards

Maple is four codebases held to one contract: a Rust core (`src/raw-pipeline/`), an Angular workspace (`src/web/`), a Swift/SwiftUI Apple app (`src/apple/`), a Bun/Elysia server (`src/api/`), and a WinUI shell (`src/windows/`). The rules below are the ones that are actually enforced — by a pre-commit hook, a CI job, or a generator — plus the handful of design conventions the enforced rules exist to protect. Read the enforcement column first: if a rule has a script behind it, that script is the source of truth and this doc is its summary.

Three things bind every language here. Formatting is a tool's job, never yours. Anything that appears in more than one language is generated from `raw-core`, never re-typed. And no file grows past 600 lines, because that's where reviewers stop reading.

---

## Formatting and pre-commit gates

`lefthook.yml` at the repo root wires the whole formatter set to pre-commit. Install once per clone:

```bash
brew install lefthook   # or: npm i -g lefthook
lefthook install
```

Every hook **soft-skips** when its binary isn't installed locally — CI is the gate, the hook is the early warning. The hooks are:

| Files                             | Tool                                     | Also gated in CI                               |
| --------------------------------- | ---------------------------------------- | ---------------------------------------------- |
| `src/api/src/**/*.ts`             | `oxlint --config src/api/.oxlintrc.json` | `cross.yml` → `oxlint-api`                     |
| `*.{rs,swift,ts,tsx,js,py}`       | `tools/check-file-budget.sh`             | `cross.yml` → `file-budget`, `budget-headroom` |
| `*.{ts,html,scss,json,yaml,md,…}` | `prettier --check`                       | `cross.yml` → `format-check`                   |
| `*.rs`                            | `rustfmt --edition 2021 --check`         | only `-p raw-ffi` (`raw-pipeline.yml`)         |
| `*.swift`                         | `xcrun swift-format lint --strict`       | not gated in CI                                |
| `*.py`                            | `ruff format --check` + `ruff check`     | not gated in CI                                |
| `*.{sh,bash}`                     | `shfmt -d`                               | not gated in CI                                |

Prettier's config is `src/web/.prettierrc` (`printWidth: 100`, `singleQuote: true`, Angular parser for `.html`) and it applies repo-wide — `src/api` and `docs/` included. There is no ESLint on web; Prettier is the only TypeScript/HTML style gate there. Reproduce the CI format job exactly with:

```bash
cd src/web
bun run format          # bash scripts/format.sh --write
bun run format:check    # bash scripts/format.sh --check  ← what CI runs
```

`scripts/format.sh` scopes to the files your branch changes versus `origin/main`, which is precisely the set CI checks — so a green local run predicts a green CI run.

Note the asymmetry in the table: `cargo fmt --check` runs in CI for `raw-ffi` only, and Swift/Python/shell formatting is pre-commit-only. Don't assume a repo-wide `cargo fmt` is safe to run and commit.

**Commit messages** must be Conventional Commits (`type(scope)?: description`, types `feat fix docs style refactor perf test build ci chore revert`), enforced by the `commit-msg` hook. `Merge`/`Revert`/`fixup!`/`squash!` lines pass through.

Two more repo-wide CI gates worth knowing before you push:

- **`fallow audit`** (`cross.yml` → `fallow-audit-web`, `fallow-audit-api`) flags dead code, complexity, and duplication. It reports pre-existing findings but fails only on ones your changeset _introduces_.
- **`gitleaks`** scans for committed secrets. There is no pre-commit credential scan — this is the only net.

## File-size budget

`tools/check-file-budget.sh` counts `wc -l` on `*.rs *.swift *.ts *.tsx *.js *.py`. C#, XAML, HTML, and SCSS are out of scope.

| Threshold | Line count | Behavior                                                                    |
| --------- | ---------- | --------------------------------------------------------------------------- |
| Soft      | 400        | Warns. Never blocks.                                                        |
| Headroom  | 570        | `tools/check-budget-headroom.sh` fails if your diff _grows_ a file past it. |
| Hard      | 600        | Blocks commit and CI unless the path is in `tools/budget-allowlist.txt`.    |

The headroom rule exists because the hard limit alone punishes the wrong pull request. Splitting a file to clear 600 naturally lands it at 598 — and then the next unrelated change that adds two lines is the one that goes red. **Split with real margin: aim well under 570.** The allowlist is a frozen day-0 audit; CI forbids appending to it, and when you split an allowlisted file you delete its entry in the same change.

```bash
bash tools/check-file-budget.sh                  # whole repo
bash tools/check-budget-headroom.sh origin/main  # what the PR gate runs
```

## Functional, immutable style

Compute a value through named, single-assignment bindings and early-return guards. Don't declare one mutable binding and reshape it across successive `if` branches — each value gets one name and the code reads as a pipeline.

In TypeScript that means `const` over a reassigned `let`; in Swift `let` over `var`; in Rust `let` over `let mut`. Write it that way the first time.

```typescript
const stripped = name.replace(CIVIC_PREFIX, '').trim();
const resolved = stripped.length > 0 ? stripped : name;
return resolved === 'New York' ? 'New York City' : resolved;
```

Scope tightly, then finish completely. Build what the ticket requires and no config knob, abstraction layer, or extension point beyond it — every speculative parameter is code that has to be read, tested, and kept at parity across three pipelines. But within that scope, ship the real thing: no stubs, no hard-coded fake data, no empty handlers. If something genuinely can't be finished in one pass, say what's blocking instead of papering over it.

---

## TypeScript

Both workspaces are `"strict": true`. The web adds `noImplicitOverride`, `noPropertyAccessFromIndexSignature`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, and `isolatedModules` (`src/web/tsconfig.json`), plus Angular's `strictTemplates`, `strictInjectionParameters`, and `strictInputAccessModifiers`.

- **Never `any`.** Take `unknown` at a boundary and narrow with a type guard. `src/api/.oxlintrc.json` warns on `typescript/no-explicit-any`.
- **Split type-only imports.** `import type { Foo } from …` — `typescript/consistent-type-imports` is an oxlint error on the API side, and `isolatedModules` makes it load-bearing on web.
- **Prefer type guards to assertions.** An `as` cast asserts something the compiler couldn't check; a `value is T` predicate makes the check real.

## Angular

The workspace is Angular 21 with two apps (`maple`, `maple-syrup`) and one library (`maple-common`). See [web](web.md) for the workspace map and build commands.

**Every component is three files** — `.ts`, `.html`, `.scss` — in a folder named after the component. No inline templates, no inline `styles`. Create the SCSS even when it starts empty; several components now have none of their own styling left after the Tailwind port, and that's fine.

**Standalone, `OnPush`, function-syntax I/O, `inject()`.** The `mui-*` design-system components are the reference implementations — `src/web/projects/maple-common/src/lib/ui/button/mui-button.component.ts` is a compact one to copy from.

```typescript
@Component({
  selector: 'mui-button',
  standalone: true,
  imports: [MuiIconComponent],
  templateUrl: './mui-button.component.html',
  styleUrl: './mui-button.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiButtonComponent {
  readonly variant = input<MuiButtonVariant>('secondary');
  readonly disabled = input<boolean>(false);
  readonly pressed = output<void>();
  private readonly router = inject(Router);
}
```

Decorator `@Input()`/`@Output()`, constructor injection, and `*ngIf`/`*ngFor` are legacy — use `input()`/`output()`, `inject()`, and `@if`/`@for`/`@empty` with a stable `track` key.

**One page component per route.** Never switch page content with `@if (viewType === …)` inside a parent; that's what `canMatch` guards and lazy `loadComponent` are for. `src/web/projects/maple/src/app/app.routes.ts` lazy-loads every route.

**Signals for synchronous local state, observables for async.** A `BehaviorSubject` inside a component to hold a counter is the wrong tool.

### Components build a view model

Services expose `Observable<T>` and only `Observable<T>` — no `firstValueFrom`, no `toPromise` at the service boundary. Components assemble a **view model**: a small object built once, bundling the observables and signals the template needs, consumed via the `async` pipe or `toSignal()`.

Non-trivial view models get their own `*.vm.ts` file beside the component — see `src/web/projects/maple-common/src/lib/components/develop/tone-curve.vm.ts`, `src/web/projects/maple-common/src/lib/info/info-panel.vm.ts`, and `src/web/projects/maple/src/app/settings/workers/workers.vm.ts`.

The payoff is concrete, not stylistic. A new slider tick cancels the in-flight histogram request through `switchMap` — with promises that's manual `AbortController` plumbing. `debounceTime`/`distinctUntilChanged`/`combineLatest` compose the way the UI actually behaves. The `async` pipe owns the subscription lifecycle, so there's no `takeUntilDestroyed` scattered through the component. And `OnPush` plus `async` plus signals means the framework only rechecks components whose inputs really changed.

Promises are fine for one-shot imperative actions (`router.navigate()`, logging) and for wrapping promise-only libraries — wrap with `from()` at the boundary.

### Routing

Internal navigation uses `routerLink` / `[routerLink]`, never `href`. A plain `href` triggers a full browser reload, which throws away Angular state and breaks history navigation.

Reserve `replaceUrl: true` for boot-level and guard redirects, for close/dismiss buttons (so Back doesn't trap the user inside a detail view), and for reactive URL sync such as updating `?q=` as the user types. Ordinary master-detail transitions must push history — users expect Back to walk backwards.

### Styling: Tailwind first, tokens always

Design tokens are generated, not authored in CSS. Hex values live in `src/raw-pipeline/raw-core/src/ui_tokens.rs`; `tools/codegen.sh` emits them to `src/web/projects/maple-common/src/lib/generated/_ui-tokens.scss` (plus `ui-tokens.ts`, Swift `UITokens.swift` for MapleCore _and_ MapleUI, and `src/windows/Maple.WinUI/Themes/Tokens.xaml`). `tokens.scss` wires the SCSS into Tailwind's `@theme` block. **A hex value never appears in a template or a component stylesheet.** If you need a color, add a token and regenerate.

The conversion recipe at `src/web/projects/maple-common/src/lib/styles/TAILWIND-CONVERSION.md` is binding for any component you port or write. Its load-bearing rules:

- **One mutually-exclusive computed string per shared CSS property.** When two states set the same property and the original SCSS resolved the winner by declaration order, do not reproduce that with two conditional utilities of equal specificity — Tailwind's generated order is not a template-level guarantee. Resolve the precedence in a `computed()` that returns only the winning classes. This holds even for a single add-on like `disabled:opacity-45` over a base `cursor-pointer`: fold both branches into the one computed.
- Prefer a built-in variant (`disabled:`, `enabled:hover:`, `peer-focus-visible:`) when Tailwind already expresses the condition natively.
- Spacing and radius utilities line up with `$maple-spacing-*` / `$maple-radius-*` by **coincidence** — those scales aren't registered in `@theme`. The coincidence stops past 4/8/16/24/32/48px, so use an arbitrary value rather than rounding to a "close" utility.
- Bare `text-{xs,sm,base}` also sets `line-height`. Pair it with an explicit `leading-*`, or use `text-[Npx]`, when the original rule only specified a font size.
- Unconditional `:host { display: X }` becomes `host: { class: 'X' }`; a conditional `:host` becomes one computed `host: { '[class]': fn }` returning the whole mutually-exclusive set.
- Marker classes (`variant-x`, `is-active`) stay even when style-free if a spec asserts on them or an external `::ng-deep` targets them. Grep before deleting a class.

Only two kinds of SCSS residue are legitimate: `@keyframes` (referenced through an arbitrary `[animation:…]` value) and pseudo-elements that need `content` plus absolute geometry, such as 44×44 hit targets. Sibling focus rings use `peer` / `peer-focus-visible:` instead.

### Compose from Maple UI, don't hand-roll markup

New UI composes `mui-*` components from `src/web/projects/maple-common/src/lib/ui/`, not raw `<button>` markup or `btn-primary`-style classes. `src/web/scripts/check-maple-ui-adoption.mjs` is an incremental ratchet: directories and files already migrated are frozen, and a raw `<button>` re-entering one fails `bun run maple-ui:adoption-check` in `web.yml`. See [unified-component-catalog](unified-component-catalog.md) for what exists on each platform.

---

## API — Bun, Elysia, MongoDB

**Route families are prefixed Elysia instances**, one exported const per file under `src/api/src/routes/`:

```typescript
export const foldersRoutes = new Elysia({ prefix: '/api/folders' })
  .get('/', listHandler)
  .post('/', createHandler, { body: t.Object({ name: t.String({ minLength: 1 }) }) });
```

Bodies and params validate through Elysia's TypeBox `t` schemas at the route, not by hand inside the handler.

**Auth is grouped, not per-route.** `src/api/src/routes/authed-api.ts` is a named sub-app that `.use(requireAuth)` once and mounts every bearer-gated family inside it. The sub-app boundary matters: `requireAuth` is a scoped derive, so without it the guard would leak forward onto the static-UI plugin and break unauthenticated cold loads. Self-gating families (Cloudflare, users, service keys) and token-in-query families (events, video) deliberately mount outside it.

**Errors are `set.status` plus a single-field body**: `return { error: 'file access permission required' }` with `set.status = 403` (`src/api/src/auth/middleware.ts`). There is no second `message` field.

**Data access lives in `*.repo.ts`** under `src/api/src/db/` (`assets.repo.ts`, `changes.repo.ts`, `backup-sessions.repo.ts`) and in per-domain repos like `src/api/src/workers/worker-config.repo.ts`. Route handlers call repo functions; they don't reach for the Mongo driver.

### The filesystem-import guardrail

`src/api/.oxlintrc.json` makes `node:fs`, `node:fs/promises`, and their bare forms **restricted imports**. Durable writes go through `src/api/src/fs/mirrored.ts` so they replicate to the backup mirror. Read-only access, temp paths, and the mirror machinery itself are legitimate exceptions — add the file to the `overrides` allowlist in that config with a one-line reason rather than silencing the rule inline.

### Tests

`bun test` is the gate (`src/api/package.json`). Mongo-backed suites need a real database — they skip-pass when none is reachable.

Scope every environment override to the suite with the helpers in `src/api/src/db/test-db.test-helpers.ts`:

```typescript
const dbName = withTestDb('maple_test_folders'); // sets MAPLE_MONGO_DB for this suite only
```

This is not a style preference. Bun evaluates every module body during the import phase, before any test runs, so a suite that assigns `process.env.MAPLE_MONGO_DB` at module scope renames the database for the whole process: the last import wins, other suites' `getDb()` connect to it, and one suite's teardown drops a database another is still using. `withTestEnv` / `withTestDb` claim the value in `beforeAll` and restore it in `afterAll`, so an override is live only while its owner runs. Capturing the previous value at module scope is the same bug in disguise. Use `tryConnectTestMongo()` for the skip-pass check rather than rolling your own timeouts.

### Configuration goes in settings, not new environment variables

Runtime configuration belongs in Maple's database-backed settings — the `worker_config` and enrichment-config collections, surfaced on the Settings pages (`/settings/workers`, `/settings/sources`, `/settings/pano`, `/settings/map`, `/settings/network`, …). A DB-backed setting is toggleable at runtime with no restart and no shell access, and it is visible in the UI. An environment variable is invisible and needs a redeploy.

Reserve environment variables for bootstrap that must be known before the database is reachable: port, `MAPLE_MONGO_URI`, `MAPLE_JWT_SECRET`, process role. A new feature toggle or threshold ships with its control on the relevant settings page, in the same change as the backend.

### Ongoing per-asset work is a stage, not a job

If the job description is "eventually, every eligible asset gets property X" — a derivative, a mirrored copy, a computed metric — it belongs in `src/api/src/workers/stages/` as a `defineStage()` stage (`src/api/src/workers/stage-config.ts`, run by `src/api/src/workers/run-stage.ts`), the same shape as `exif`, `thumb`, `preview`, `describe`, `geocode`, `meili`, `transcribe`. That machinery hands you pause/resume, concurrency, retry with backoff, dead-lettering, and a live progress row on Settings → Workers for free. A one-off job or a bespoke settings-page button reimplements a worse version and is invisible to the operator everywhere else.

Registering a stage is three additions plus a label: the stage's own `startXStage()` export; entries in both `stageManifest` and `ALL_STAGE_NAMES` in `src/api/src/workers/stages/manifest.ts` (this is what makes existing assets retroactively eligible and what the generic status counters key off); an entry in `STAGE_STARTERS` in `src/api/src/workers/orchestrator.ts` (what boots the poll loop); and a `STAGE_META` entry in `src/web/projects/maple/src/app/settings/workers/workers.vm.ts` for a human-readable name.

Ordering between stages is declared, not scheduled: each stage lists a `dependsOn` array of `{ name, minVersion }` entries, and the claim query parks an asset until every upstream stage has reached that version. Position in the manifest means nothing. A stage that discovers its upstream produced something unusable returns `{ rearm: { stage, reason } }`, which resets that upstream stage rather than marking the asset done.

A stage that depends on configuration the operator may not have set yet — an API key, a service URL — starts `pausedOnFirstBoot: true`. `src/api/src/workers/stages/geocode.ts` is the precedent. This matters because a stage's `{ skip }` / `{ wrote }` / `{ patch }` return marks that asset permanently handled, so "not configured yet" must never reach that return path.

Reserve `src/api/src/job-runner/` (`batch-jpeg-export.ts`, `pano-stitch.ts`) for genuinely one-off, user-selected actions bounded to a request: export these chosen photos, stitch this panorama. See [indexer-enrichment](indexer-enrichment.md) for the runtime.

---

## Swift and SwiftUI

Code lives in three local SPM packages under `src/apple/Packages/` plus the Xcode app targets:

- **MapleCore** — pipeline, sidecars, source adapters, caches, view models. Also ships `MapleCloudKit`, deliberately dependency-free so the tvOS target can link it without `RawPipeline`.
- **MapleUI** — the design system. Dependency-free by contract: no MapleCore import, no third-party packages, because sibling apps consume it directly. macOS 14 / iOS 17.
- **MapleBackup** — backup engine.

### Module boundary

Shared domain logic belongs in MapleCore, not in the app target — `src/apple/Packages/MapleCore/Sources/MapleCore/BrowseViewModel.swift` is the pattern. Platform `#if` guards are confined to views. MapleUI stays free of both: no MapleCore import, no app-specific types.

### `@Observable` state, actor-isolated I/O

State the UI observes is `@MainActor` + `@Observable`. Disk and network work runs behind an actor — `src/apple/Packages/MapleCore/Sources/MapleCore/Editor/PresetStore.swift` is an actor precisely so its disk I/O can't race with the UI. `@Published` and `ObservableObject` are superseded by `@Observable`.

### Generation counters for async state

Generation counters guard every async write into observed state. A folder switch, a search, a map fetch, or a metadata capture that resolves after the user moved on must not write. Bump a counter before the await, re-check it after, and return if it moved:

```swift
@MainActor
func loadAssets(for folder: URL) async {
    loadGeneration &+= 1
    let gen = loadGeneration

    let urls = await filesystemSource.listImages(in: folder)
    guard gen == loadGeneration else { return }   // user switched folders

    for (index, url) in urls.enumerated() {
        let asset = await loadAsset(url)
        guard gen == loadGeneration else { return }
        assetSlots[index] = asset
    }
}
```

Live examples: `BrowseViewModel.swift`, `MapViewModel.swift` and `SearchViewModel.swift` in `MapleCloudKit/Cloud/`, `PanoMergeSession.swift`, `src/apple/Maple TV/LightTableViewModel.swift`, and `src/apple/Maple/Views/PairAppleTVViewModel.swift`. Request-identity comparison is an acceptable variant where the request already has a natural identity (`BatchMetadataCaptureSection.swift`).

### Platform-gated code needs both builds

A change behind `#if os(...)` must be built on every platform it touches. CI's only Swift gate is `swift build` of the MapleCore package on macOS (`.github/workflows/apple.yml`) — it never type-checks an `#if os(iOS)` or `#if os(tvOS)` branch, and it never builds the app targets at all. There are over 200 such guards in `src/apple`. A macOS-only modifier inside an iOS branch compiles green in CI and fails at the TestFlight archive. Build the iOS and tvOS destinations locally before you push. See [apple](apple.md) for the commands.

**Delete template scaffold.** Xcode's `ContentView`/`Item` placeholders go when you replace them.

## Rust core

`raw-core` is pure image math with no Apple or browser dependencies. It reaches platforms three ways: `raw-ffi` → the Apple xcframework, `raw-wasm` → the browser bundle, `raw-gpu` → the WGSL kernels. `maple-cli` is the headless harness. Details in [pipeline](pipeline.md).

- **Determinism is a hard requirement.** Same input plus same parameters gives byte-identical output across machines and across the WASM/native split. No wall-clock reads, no unseeded RNG, no parallel reductions with non-associative operators. `src/raw-pipeline/raw-core/src/api.rs` states this as a module invariant, and the baseline harness catches violations.
- **No filesystem access in the core.** Entry points take and return bytes; the shell owns I/O.
- **Never panic on bad input.** Library code returns `Result<T, E>`. `unwrap`/`expect` belong in tests and binaries.
- **`rayon` for CPU parallelism.** Pixel-decomposable stages use parallel iterators; don't spawn threads by hand.
- **Every stage gets unit tests**, and the ACR-referenced perceptual harness is the integration gate. Roughly one test per public function and per failure mode — not per line.
- **A stage change must land its GPU counterpart.** `cargo test -p raw-core` cannot see WGSL divergence; `raw-pipeline.yml` runs a separate `raw-gpu` job that validates the shaders with `naga` and checks raw-core ↔ GPU parity.

Anything that exists in two languages is single-sourced. Color matrices, the adjustment schema, UI tokens, and the film catalog are all emitted by `src/raw-pipeline/codegen` through `tools/codegen.sh`, and `cross.yml`'s `codegen-drift` job regenerates them and fails on any diff. Change the Rust constant and run the generator; never hand-edit a generated file.

## Naming

| Language           | Convention                                                                 |
| ------------------ | -------------------------------------------------------------------------- |
| Web files          | kebab-case: `mui-button.component.ts`, `auth.service.ts`, `assets.repo.ts` |
| Web suffixes       | `.component` `.service` `.repo` `.guard` `.interceptor` `.vm` `.spec`      |
| Angular components | one standalone component per folder, folder named after the component      |
| Swift              | PascalCase types; design-system types prefixed `Mui`                       |
| Rust               | snake_case modules and functions                                           |
| C# (WinUI)         | PascalCase; design-system types prefixed `Mui`                             |

---

## Don't ship these

| Anti-pattern                                           | Instead                                      |
| ------------------------------------------------------ | -------------------------------------------- |
| `firstValueFrom` / `toPromise` in a service            | return `Observable<T>`                       |
| `any`                                                  | `unknown` plus a type guard                  |
| `BehaviorSubject` for local component state            | a signal                                     |
| `@Input()` / `@Output()` decorators, constructor DI    | `input()`, `output()`, `inject()`            |
| `*ngIf` / `*ngFor`                                     | `@if` / `@for` with a stable `track`         |
| Inline templates or styles                             | separate `.ts` / `.html` / `.scss`           |
| Hardcoded hex colors                                   | a generated token                            |
| `href` for internal navigation                         | `routerLink`                                 |
| Raw `<button>` in a ratcheted directory                | `mui-button`                                 |
| Two conditional Tailwind utilities on one CSS property | one `computed()` returning the winner        |
| `import { Type, value }` from one module               | a separate `import type`                     |
| `fetch()` in Angular code                              | `HttpClient`                                 |
| `node:fs` in `src/api`                                 | `src/api/src/fs/mirrored.ts`                 |
| `process.env.X = …` at test module scope               | `withTestEnv` / `withTestDb`                 |
| A raw Mongo driver call in a route handler             | a `*.repo.ts` function                       |
| A new environment variable for a feature toggle        | a DB-backed setting with a Settings control  |
| A JobRunner job for ongoing per-asset work             | a `defineStage()` stage                      |
| `unwrap()` in Rust library code                        | `Result<T, E>`                               |
| An unguarded `await` writing into observed Swift state | a generation-counter guard                   |
| Hand-editing a file under a `generated/` directory     | edit the Rust source, run `tools/codegen.sh` |
| A colour-pipeline change with no harness run           | `src/scripts/test_color_pipeline.sh`         |

---

## Related

- [architecture](architecture.md) — how the products and the shared core fit together
- [web](web.md), [apple](apple.md), [api](api.md), [windows](windows.md) — per-surface build and test
- [pipeline](pipeline.md) — the Rust image chain and codegen
- [caching](caching.md) — every cache, its key, and its invalidation rule
- [testing](testing.md) — the full gate and harness inventory
- [unified-component-catalog](unified-component-catalog.md) — the design-system inventory
- `CONTRIBUTING.md` — ticket, commit, and merge policy
