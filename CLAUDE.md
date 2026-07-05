# Maple

A professional, non-destructive RAW photo editor by Just Maple. Runs natively on macOS, iPadOS, and iOS via a Swift + SwiftUI shell, and in evergreen browsers via Angular — both backed by a shared Rust image-processing core.

The product bar is: color quality that a working photographer will trust, and a slider that responds inside a single 60Hz frame on a 100MP RAW.

## Product summary

Three-column shell (sources tree / image grid / detail inspector) on desktop and tablet, single-column on phone. Two modes — **Browse** (grid) and **Full image** (large preview with filmstrip). Every edit is non-destructive and persists to **XMP sidecars** — originals are never touched.

The full feature spec is in `docs/feature-spec.md`. The UI contract is in `docs/ui-spec.md`. The interactive layout reference is `docs/mockup.html`. These are the source of truth, not this file. For the engineering contract (file-size budget, commit rules, tooling), see `CONTRIBUTING.md`.

## Load-bearing principles

Treat these as invariants. If you're about to violate one, stop and ask.

1. **Non-destructive only.** Original files are never modified. All edits go to `.xmp` sidecars. The sidecar is the contract; the pixels are derived.
2. **Scene-referred pipeline.** The working space is linear Rec.2020 D65 at f32. Exposure is a linear multiply. A single view transform at the end of the chain compresses scene range into display range. Nothing before the view transform clips.
3. **One Rust core, three native pipelines.** Color math (decode, demosaic, calibration, LUT generation, dehaze, deconvolution) lives in `src/raw-pipeline/crates/raw-core`. That crate compiles once as a static library for Apple (via C-FFI) and once as WebAssembly for browsers. Platform GPU paths (Metal, WebGL2) are idiomatic on each platform but gated against the Rust reference.
4. **Parity before features.** Pixel parity between Apple and Web is a merge gate, not an aspiration. See `docs/testing.md` for the harness.
5. **Performance is a product feature.** Target: slider tick renders a new preview inside 16ms on supported hardware. No feature ships that breaks that budget on the reference scene set.
6. **Finish the work — no placeholder shortcuts.** Ship complete, working implementations. Never leave stubs, `TODO`/`FIXME` gaps, hard-coded fake data, empty handlers, or "wire this up later" holes dressed up to look done. If something genuinely can't be completed in one pass, **stop and say what's blocking** — don't paper over it. The only allowed exception is deliberate, incremental staging that is tracked by a referenced ticket and called out explicitly in the code (e.g. an overlay gated behind `#629` with a comment saying so); a silent placeholder is never acceptable. When in doubt, do the real thing.

   The same bar applies at the epic level, not only within a single file or PR. A piece of work that a plan, a design doc, or a sequencing decision split into an ordered set of sub-issues is not "done" until every sub-issue in that set has landed — completion of the first slice is a progress checkpoint, not a finish line, and is not itself a reason to pause. A genuine blocker looks like a decision only the human requester can make, a missing credential or fixture, or a merge outside current authorization; a separate ticket number for the next slice is not, on its own, one of those. Sub-issues with no dependency on each other's output — independent Settings pages, independent Worker projects, and the like — are natural candidates for parallel implementation rather than an artificially imposed sequence.
7. **YAGNI — build for today's requirement, not a speculative tomorrow.** "You Aren't Gonna Need It," the Extreme Programming / agile principle: implement only what a current ticket actually requires. Don't add config knobs, abstraction layers, generic "frameworks," extra parameters, or extension points on the bet that they'll be useful later — speculative generality is a cost now (more code to read, test, keep at parity across three pipelines) against a benefit that usually never arrives. Prefer the concrete implementation that solves the case in front of you; generalize when a _second_ real caller forces it, not before. This bounds _what_ you build; #6 governs how completely you build it — the two are complementary, not in tension: scope tightly, then finish what's in scope with no stubs. If a requirement seems to call for speculative scaffolding, **stop and ask** rather than building it on spec.

## Tech stack

| Layer         | Apple                                 | Web                                | Shared                           |
| ------------- | ------------------------------------- | ---------------------------------- | -------------------------------- |
| UI            | SwiftUI                               | Angular 21 + standalone components | —                                |
| State         | `@Observable` (Observation framework) | Signals + RxJS observables         | —                                |
| Image decode  | Rust core via C-FFI (xcframework)     | Rust core via WASM                 | `raw-core` crate                 |
| GPU pipeline  | Metal Shading Language                | WebGL2 GLSL ES 3.0                 | Coefficients generated from Rust |
| Sidecar I/O   | Custom XMP writer in Swift            | Custom XMP writer in TypeScript    | Schema validated on both sides   |
| Thumbnails    | `CGImageSource` + disk cache          | WASM thumb extraction + IndexedDB  | —                                |
| API (web)     | —                                     | Angular `HttpClient` → Bun/Elysia  | Shared DTO types via codegen     |
| Offline (web) | —                                     | Angular service worker + IndexedDB | —                                |

## Project layout

```
src/
  apple/                      # Swift app (Mac, iOS, iPad) — SPM-based
    Package.swift             # Declares MapleCore + MapleApp targets
    Sources/MapleCore/        # Pipeline, sidecar, source adapters, caches
    Sources/MapleApp/         # SwiftUI shell (AppShell, Browse, FullImage, DetailPanel)
    Frameworks/               # RawPipeline.xcframework (committed binary)
    Resources/                # Icon set, entitlements, TestFlight notes
    Tests/                    # MapleCoreTests
    scripts/                  # build-xcframework.sh
  raw-pipeline/               # Rust core (cargo workspace)
    raw-core/                 # Pure Rust image math (no platform deps)
    raw-ffi/                  # cbindgen C headers for Apple xcframework
    raw-wasm/                 # wasm-bindgen bindings for Web
    maple-cli/                # Deterministic headless CLI harness
    codegen/                  # Rust → Swift/TS/SCSS/WGSL generator (run via tools/codegen.sh)
  web/                        # Angular workspace (Maple Hosted UI; also consumed by Self Hosted)
    projects/
      maple/                  # The editor/browse application
      maple-common/           # Shared library (components, services, models, raw-wasm consumer)
    ngsw-config.json          # Service worker configuration
  api/                        # Bun + Elysia + MongoDB (Maple Self Hosted backend + Indexer)
    src/                      # Elysia routes, db, ffi, fs, indexer
    native/                   # libmaple_core dylib consumed via bun:ffi
  scripts/
    test_color_pipeline.sh    # Color parity harness
    compare_images.py         # ΔE₀₀ + per-channel bias metric
    derive_agx_lut.py         # AgX coeffs/LUT → agx_coeffs.rs + agx_lut.bin + WGSL

docs/
  feature-spec.md             # What the product does
  ui-spec.md                  # How screens look/behave
  architecture.md             # System design
  best-practices.md           # Coding standards — read this
  mockup.html                 # Interactive layout reference
  pipeline.md, caching.md, testing.md, ...
```

## Read before editing

- **Changing a color pipeline stage?** Read `docs/architecture.md` § "Scene-linear chain" and `docs/testing.md` § "Parity gates." Every stage change runs the parity harness.
- **Adding an Angular component?** Read `docs/best-practices.md` § "Angular". TL;DR: standalone, signals, `input()`/`output()`, separate `.ts`/`.html`/`.scss` files, observables at the service layer, view models in components.
- **Adding a Swift view?** Read `docs/best-practices.md` § "Swift". TL;DR: `@Observable`, actor-isolated I/O, generation-counter guards for async state.
- **Touching the XMP schema?** Read `docs/sidecar-schema.md`. Schema changes are versioned; passthrough XML preserves unknown fields byte-for-byte.
- **Touching the describe stage?** Read `.archived-plans/specs/2026-05-19-qwen-vision-ocr-design.md` first — it covers the structured `VisionDoc`, the preview-stage dependency, and the no-XMP-for-derived-data invariant. See the 2026-05-19 update at the end: qwen2.5-vl is the sole OCR source; the parallel Tesseract stage was removed in #158.

## Build & test — Apple

The app is an Xcode project (`src/apple/Maple.xcodeproj`) that consumes a local Swift package at `src/apple/Packages/MapleCore/` plus the `Frameworks/RawPipeline.xcframework` binary built from the Rust core.

**First build after clone:** the `libraw_ffi.a` files inside the xcframework are gitignored (200–500 MB each, over GitHub's limit). Build them once before the first Xcode build:

```bash
./src/apple/scripts/build-xcframework.sh
```

The script defaults to a **release** build. Pass `--debug` only for fast-compile iteration when pano performance is irrelevant — a debug xcframework makes `maple_pano_stitch` run ~16× slower (measured: 5785s debug vs 353s release for the same 21-frame stitch on M4). CI (Xcode Cloud) always builds release.

This needs Rust + cbindgen + the iOS/macOS Rust targets (`rustup target add aarch64-apple-ios aarch64-apple-ios-sim aarch64-apple-darwin x86_64-apple-darwin`). The script regenerates the Headers, the `module.modulemap`, and the per-platform static libs.

```bash
# macOS build
cd src/apple
xcodebuild -project Maple.xcodeproj -scheme "Maple Exposure" -destination 'platform=macOS' build

# iOS simulator (pick any installed arm64 simulator; iPhone 17 Pro / iPhone 16 Pro work)
xcodebuild -project Maple.xcodeproj -scheme "Maple Exposure" \
           -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build

# Unit tests (runs inside the local package — Xcode test target is a stub)
cd Packages/MapleCore && swift test
```

The xcframework's iOS simulator slice is arm64 only today, so `-destination 'generic/platform=iOS Simulator'` fails on the x86_64 link step — pass a specific simulator destination instead.

When testing a UI change:

1. Build via `xcodebuild` or open `Maple.xcodeproj` in Xcode.
2. Launch the built `.app` (macOS) or install on the simulator (iOS).
3. Use accessibility tree inspection, not coordinate taps — every interactive element must have an accessibility label.
4. Screenshot before and after; `capture_logs` catches runtime errors.

If ΔE numbers don't move after a `raw-core` edit, the xcframework is stale. Rebuild it.

### UITest visual harness

Companion to the Rust color-pipeline harness at `src/scripts/test_color_pipeline.sh`. Same metric (CIEDE2000), different scope: live SwiftUI canvas screenshot vs committed golden, instead of `maple-cli` PNG vs ACR reference. Lives in the `MapleUITests` Xcode target at `src/apple/MapleUITests/`.

Run locally:

```bash
xcodebuild test \
  -project src/apple/Maple.xcodeproj \
  -scheme "Maple Exposure" \
  -destination 'platform=macOS' \
  -only-testing:MapleUITests \
  MAPLE_UITEST_FIXTURE_ROOT="$PWD/test-fixtures/raws"
```

The harness launches Maple with `MAPLE_UITEST_FIXTURE=test_0017.dng` (resolved against `MAPLE_UITEST_FIXTURE_ROOT`), waits for the refine pass to publish a preview (`canvas-render-ready` accessibility identifier flips on), screenshots the canvas, and diffs against the committed PNG at `src/apple/MapleUITests/Goldens/test_0017-default.png`. Goldens are tiny (canvas-only crop — no chrome) and commit to the repo.

Re-record by deleting the PNG and re-running — the harness will write a new baseline and fail with a "baseline written" message. Open the file, eyeball it, then commit + re-run.

Without fixtures (CI without `test-fixtures/raws/test_0017.dng`), the test calls `XCTSkip` — soft pass, mirrors the `test_color_pipeline.sh` "no fixtures, skipping" pattern.

**First-time-on-a-machine caveat (macOS):** the UI test runner asks for keychain / TouchID auth on its first launch. The `xcodebuild test` invocation will hang for several minutes and then fail with `LocalAuthentication ... System authentication is running. ... BiometryType=1`. The fix is to authorize once interactively — opening the project in Xcode and running the test through the IDE the first time produces an OS prompt the user can accept; subsequent CLI runs reuse the cached credential. There is no headless workaround on stock macOS.

The Swift CIEDE2000 port at `src/apple/MapleUITests/Helpers/CIEDE2000.swift` is cross-validated against `src/scripts/compare_images.py` by `CIEDE2000Tests`, against the calibration PNG pair at `src/apple/MapleUITests/Goldens/.calibration/`. Regenerate the expected JSON via:

```bash
python3 src/scripts/compare_images.py \
  src/apple/MapleUITests/Goldens/.calibration/a.png \
  src/apple/MapleUITests/Goldens/.calibration/b.png \
  > src/apple/MapleUITests/Goldens/.calibration/expected.json
```

Brief: `.archived-plans/specs/2026-04-25-xcuitest-visual-harness-brief.md`. Plan: `.archived-plans/plans/2026-04-25-xcuitest-visual-harness.md`.

### Slider-matrix harness

Companion test class `SliderMatrixUITests` (Ticket 10-C) at `src/apple/MapleUITests/SliderMatrixUITests.swift`. Iterates every committed slider XMP under `test-fixtures/references/test_NNNN/xmp/` against the matching ACR-rendered reference at `test-fixtures/references/test_NNNN/down/<case>.png`. Per case: stages a tmp dir with the RAW + XMP renamed to `<stem>.xmp`, relaunches Maple pointed at the tmp, screenshots the canvas, resizes both to 1024px long edge, CIEDE2000-diffs.

Run:

```bash
xcodebuild test \
  -project src/apple/Maple.xcodeproj \
  -scheme "Maple Exposure" \
  -destination 'platform=macOS' \
  -only-testing:MapleUITests/SliderMatrixUITests
```

Budgets are loose (mean ≤ 25, p95 ≤ 50, max ≤ 100, bias ≤ 0.10) to absorb the Maple-AgX-vs-ACR view-transform delta — ratchet downward as the pipeline tightens. Skip-passes when fixtures or references are absent. JSON-per-case report goes to stderr; failed cases attach candidate + reference PNGs as `XCTAttachment`s for triage.

## Build & test — Web

```bash
# Dev server
cd src/web
bun x ng serve maple          # http://localhost:4200

# Rebuild WASM (after raw-core or raw-wasm changes)
cd src/raw-pipeline/raw-wasm
wasm-pack build --target web
# sync into maple-common (the consumer) — see src/web/scripts/sync-raw-wasm.sh

# Format + test (there is no web lint step — Prettier is the only style gate)
cd src/web
bun run format        # prettier --write over files this branch changes vs origin/main
bun run format:check  # mirrors CI's format gate (.github/workflows/cross.yml format-check)
bun run test
```

To load a RAW file in dev automation without the native picker, drop it into `projects/maple/public/test.dng` and feed it into the hidden `<input type="file">` via `DataTransfer`. Setting `input.files` programmatically does not fire `change` — the synthetic event is required.

**Canvas color-space (Web):** on WebGPU-capable browsers the live canvas routes through `render_bytes_gpu` (the GPU live path); `render_bytes` (WASM-CPU) is the fallback when WebGPU is unavailable. The render worker (`src/web/projects/maple-common/src/lib/raw-pipeline/raw-pipeline.worker.ts`) tags the canvas surface as **display-P3** once at session open, reading back the browser-configured value via `getConfiguration()`. This matches the wide-gamut output of the core; do not assume an sRGB canvas. (The old dev-only `webgl-pipeline.ts` GLSL path was removed in the #925 wgpu/WGSL unification.)

## Build & test — API (Bun / Self Hosted)

```bash
cd src/api
bun install
bun test                      # unit + integration tests
bun run dev                   # Elysia on http://localhost:3000

# Native core as a bun:ffi dylib (rebuild after raw-core / raw-ffi changes)
./src/api/scripts/build-raw-ffi.sh
```

The API serves the pre-built `src/web` Angular bundle for a complete Self Hosted deploy. MongoDB is expected on `mongodb://localhost:27017` by default (override via `MONGO_URL`).

## Build & test — Rust core

```bash
cd src/raw-pipeline
cargo test -p raw-core --lib            # ~840 lib tests (70 ignored, fixture-gated)
cargo test -p raw-core --all-features   # includes fixture-gated tests

# Color pipeline harness (CI gate — diffs vs ACR references, per-case budgets in test-fixtures/budgets.json)
src/scripts/test_color_pipeline.sh
FILTER=baseline src/scripts/test_color_pipeline.sh   # subset to baseline cases for a fast spot-check

# CLI harness — deterministic, headless, matches WASM/Swift-FFI output
cd src/raw-pipeline
cargo run --release --bin maple-cli -- batch manifest.json --out-dir candidates/
```

Diagnostic examples:

```bash
# Per-stage RGB dump at one pixel through the full pipeline
cargo run --release -p raw-core --example stage-trace -- <DNG> <X> <Y>

# Raw-value statistics vs declared white_level
cargo run --release -p raw-core --example raw-stats -- <DNG>
```

Fixtures at `test-fixtures/raws/` (repo-root, not under `src/raw-pipeline/`) are gitignored. Reference RAW is a 100MP Hasselblad L3D-100c (DJI Mavic 3 Pro) frame at `test-fixtures/raws/dji-mavic3pro-100mp.dng`.

## Objective color testing — no eyeballing

Every color-pipeline change must pass the perceptual harness against ACR-rendered references. Screenshot comparisons are not acceptable evidence.

The testing surface has two layers — a broad end-to-end gate and per-domain unit/integration gates that all run in CI:

```bash
# Broad end-to-end perceptual gate (the canonical color-correctness signal).
src/scripts/test_color_pipeline.sh

# Per-domain gates (fast unit/integration tests for specific subsystems).
src/scripts/test_synthetic_grey.sh        # neutral pipeline + flatness invariants on a hand-rolled DNG
src/scripts/test_grey_adjustments.sh      # closed-form predictors for every scene-linear slider + ACR parity
src/scripts/test_grey_dcp.sh              # DCP code-path coverage (ColorMatrix1/2, ForwardMatrix1/2, PTC)
```

The end-to-end gate runs `maple-cli batch` against every case in `test-fixtures/references/manifest.json`, diffs each candidate vs. the ACR-rendered reference, and gates per-fixture × per-case `mean / p95 / max / bias` against `test-fixtures/budgets.json`. **Budgets are a one-way ratchet — they can only go down.** Lowering a budget happens in the same commit that delivers the improvement.

Adding a new case to the end-to-end gate:

1. Render the ACR reference and place it under `test-fixtures/references/test_NNNN/down/<case>.png`.
2. Add the case to `test-fixtures/references/manifest.json`.
3. Run the harness once — it will FAIL with `no-budget-entry` for the new case.
4. Inspect the printed `mean`/`p95`/`max`/`bias`, add a `budgets.json` entry whose ceilings are roughly 5–10% above those numbers (or pipe the captured table through `tools/budget_init.py` and merge).
5. Commit the case, manifest entry, and budgets.json entry together.

Spot-check a single fixture:

```bash
FILTER=test_0000 src/scripts/test_color_pipeline.sh
FILTER=baseline src/scripts/test_color_pipeline.sh
```

Sanity check vs the camera's embedded JPEG preview (NOT a CI gate — varies per camera body):

```bash
tools/sanity-checks/test_embedded_preview.sh
```

When fixtures aren't present locally (e.g. CI without the gitignored RAWs), every gate skip-passes with a "skipping" message and exit 0 — so CI without fixtures doesn't fail spuriously.

## Cross-platform parity

Every constant and schema that appears in more than one language is single-sourced from `raw-core` and emitted by the `codegen` crate (`src/raw-pipeline/codegen`), driven by `tools/codegen.sh`. It writes:

- Swift `let` constants (`AdjustmentModel+Generated.swift`, `UITokens.swift`)
- TypeScript `export const` constants (`adjustment-model.generated.ts`, `ui-tokens.ts`)
- SCSS tokens (`_ui-tokens.scss`)
- WGSL consts for the GPU path (`color_matrices.wgsl`, `agx_coeffs.wgsl`)

The `codegen-drift` CI job (`.github/workflows/cross.yml`) confirms the committed outputs match a fresh generation, so the per-platform copies cannot drift. When a matrix or schema changes, run `tools/codegen.sh` and commit the regenerated files.

## Performance invariants

- **Slider tick:** 16ms target, 50ms hard limit, on the reference scene set.
- **Cold image open (cached):** one frame (~35ms) from click to pixels.
- **Cold image open (uncached):** 250–1000ms. Show progress.
- **Two-phase rendering:** fast phase (viewport, screen-res, cancellable) → 150ms debounced refine phase (full image, full resolution).
- **Five caches:** thumbnail memory, thumbnail disk, rendered-preview (keyed on `(primary_url, primary_mtime, sidecar_mtime, screen_size, adjustment_version, view_transform_version)`), decoded-image (session-scoped, in-memory), remote-source-bytes (for network shares). On web: IndexedDB + in-memory equivalents. See `docs/caching.md`.

If a new feature adds allocation inside the render loop, it does not ship. If it adds a round-trip across the WASM boundary per slider tick, it does not ship. Budget first, optimize later only when profiling says so.

## Conventions

- **Don't keep template scaffold code around.** If an Xcode or Angular generator leaves a placeholder (`ContentView`, `AppComponent` hello-world), delete it when you replace it.
- **Prefer functional, immutable style.** Compute a value through immutable bindings (a ternary or a helper call) and early-return guards instead of mutating one binding across successive `if` branches — each binding is named once and the code reads as a pipeline of values. In TypeScript that means `const` over a reassigned `let`; in Swift use `let` (not `var`) and in Rust `let` (not `let mut`) wherever the value doesn't truly need to change. Write it this way the first time, not after review. e.g. `const stripped = name.replace(CIVIC_PREFIX, '').trim(); const final = stripped.length > 0 ? stripped : name; return final === 'New York' ? 'New York City' : final;` — not a `let out` mutated through successive `if`s.
- **Prefer SPM modules** over a monolithic app target as soon as a feature has more than ~3 files. The pipeline, sidecar layer, and source adapters live in `src/apple/Sources/MapleCore`.
- **Prefer Angular library projects** in `projects/maple-common` for cross-cutting code (used by both Hosted and Self Hosted deployments of the same Angular shell).
- **No mocks for the sidecar layer in tests.** Round-trip against real `.xmp` files in a temp directory. XMP is the contract; mocks let bugs through.
- **Bundle ID:** `app.justmaple.aperture` (tests append `.Tests` / `.UITests`).
- **Every PR closes a ticket.** Before starting work, ensure a GitHub issue exists for it — if not, open one (`gh issue create`) and add it to the right Project board (Files for FP work, KTLO for hygiene/bugs/refactors). Every PR description must include a `Closes #N` (or `Fixes #N`) line so the ticket auto-closes on merge. No drive-by PRs without a ticket.
- **Open PRs as ready for review, not draft.** Drafts don't trigger CI or code review; open every PR ready so the gates run and reviewers see it immediately. If a branch genuinely isn't ready, don't push the PR yet.
- **Configure via the settings system, not new env vars.** App and runtime configuration belongs in Maple's DB-backed settings (the `worker_config` / enrichment-config collections, surfaced through the settings pages — `/settings/workers`, `/settings/enrichment`), not in new environment variables. A DB-backed setting is operator-toggleable at runtime (no restart, no shell access on the server) and shows up in the UI; an env var is invisible and requires a redeploy. New feature toggles and tunables (diagnostics, thresholds, worker knobs) must be added as settings with a control on the relevant settings page. Reserve environment variables for deploy/infra bootstrap that must be known before the DB is reachable — port, `MAPLE_MONGO_URI`, process role, secrets. (Existing env-gated diagnostics like `MAPLE_DIAG_EVENTLOOP` should migrate to settings when next touched, not be extended.)

## Notes

- macOS builds use the `My Mac` destination, not a simulator UDID.
- System permission dialogs (camera, files, photos) can't be dismissed by automation. Handle them manually on first run.
- For menu-bar items and other system UI, fall back to `osascript`.
- The Xcode app target uses `GENERATE_INFOPLIST_FILE = YES`. To set Info.plist keys, add `INFOPLIST_KEY_*` build settings in `project.pbxproj` — do not create an `Info.plist` file.

## What lives where

| If you need to…                           | Read this                            |
| ----------------------------------------- | ------------------------------------ |
| Decide what a feature should do           | `docs/feature-spec.md`               |
| Decide how a screen should look or behave | `docs/ui-spec.md`                    |
| See the layout in motion                  | `docs/mockup.html` (open in browser) |
| Look up a color, font, or spacing token   | `docs/ui-spec.md` § "Visual design"  |
| Look up the sidecar XMP schema            | `docs/sidecar-schema.md`             |
| Pick a pattern for an Angular component   | `docs/best-practices.md` § "Angular" |
| Pick a pattern for a Swift view           | `docs/best-practices.md` § "Swift"   |
| Add a cache                               | `docs/caching.md`                    |
| Understand the render pipeline            | `docs/architecture.md` § "Pipeline"  |
| Add or change a parity gate               | `docs/testing.md`                    |
