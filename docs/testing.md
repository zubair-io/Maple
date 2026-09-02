# Testing and CI

Maple's test surface has three layers. **Unit and integration tests** run per language in their own toolchain (`cargo test`, `swift test`, `bun test`, `ng test`, `dotnet test`, `vitest`). **Harness gates** are shell scripts under `src/scripts/` that render images through the real pipeline and compare them numerically — against Adobe Camera Raw references, against committed goldens, or against closed-form predictions — with per-case ceilings stored in JSON files that may only ever get stricter. **Repo tooling gates** under `tools/` guard cross-cutting invariants: file size, generated-code drift, budget ratchets, component-contract docs. Ten GitHub Actions workflows wire these into CI; a few of the heaviest harnesses depend on RAW fixtures that are gitignored, so they deliberately no-op on a stock runner and only become meaningful on a fixture-provisioned machine.

The rule that shapes everything colour-related: **no eyeballing**. A screenshot comparison is never acceptable evidence for a pipeline change. The number that counts is CIEDE2000 (ΔE₀₀) plus per-channel bias, produced by one shared implementation in [`src/scripts/compare_images.py`](../src/scripts/compare_images.py).

---

## CI workflows

Ten workflows live in `.github/workflows/`. Branch protection is not configured in the repository, so "required" is a project convention rather than a server-side rule — the standard in `CLAUDE.md` is that a PR merges only when every check is green **on the current tip of `main`**, which means a branch whose base has moved needs a rebase and a fresh run.

| Workflow              | Job(s)                                                                      | What it actually runs                                                                                                                                                                    | Trigger                                                                              |
| --------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `cross.yml`           | 11 jobs (see [Repo tooling gates](#repo-tooling-gates))                     | prettier, oxlint, file budgets, budget ratchets, codegen drift, dead-code audits, secret scan, UI contract docs                                                                          | every push to `main` + every PR, **no path filter**                                  |
| `web.yml`             | `web-build`, `web-test`, `web-test-common`                                  | `ng build maple` + `ng build maple-syrup` + artifact/capability/adoption checks + a Playwright artifact suite; `ng test maple`; `ng test Maple-common`                                   | every push to `main` + every PR, **no path filter** (deliberate — see below)         |
| `api.yml`             | `api-tests`                                                                 | `bun test --timeout 30000` against a real Mongo 7 service, then the Meilisearch integration suite against a real `getmeili/meilisearch:v1.50.0`                                          | every push to `main` + every PR + `workflow_dispatch`                                |
| `raw-pipeline.yml`    | `build-raw-ffi`, `raw-gpu`, `rust-tests`, `color-pipeline`, `pano-pipeline` | FFI compile+test, GPU/WGSL parity on software Vulkan, fixture-free Rust tests + synthetic gates, the ACR colour harness, the pano harness                                                | pushes/PRs touching `src/raw-pipeline/**`, the harness scripts, or the budget JSONs  |
| `apple.yml`           | `swift-build`                                                               | `swift build` of the MapleCore package on macOS, against a cbindgen-generated header and a **stub** `libraw_ffi.a`                                                                       | pushes/PRs touching `src/apple/**` or `src/raw-pipeline/**`                          |
| `windows.yml`         | `windows-build-and-test`                                                    | `cargo check` raw-core/raw-ffi for MSVC, `cargo test -p raw-core --lib`, build `maple-windows` + `Maple.WinUI`, `dotnet test` the WinUI suite, then re-run `tools/codegen.sh` on Windows | every push to `main` + every PR                                                      |
| `cloudflare.yml`      | `cloudflare-test`                                                           | `npm run typecheck` + `npm test` (vitest on `@cloudflare/vitest-pool-workers`)                                                                                                           | pushes/PRs touching `src/cloudflare/**`                                              |
| `face-clustering.yml` | `face-clustering-quality`                                                   | `src/scripts/test_face_clustering.sh`                                                                                                                                                    | pushes/PRs touching `src/api/src/people/**`, the script, or its fixtures             |
| `deploy-hosted.yml`   | `build-and-deploy`                                                          | Builds `maple-syrup` and uploads it to Azure Blob. **Publishing, not gating**                                                                                                            | pushes to `main` touching `src/web/**` or `src/raw-pipeline/**`; `workflow_dispatch` |
| `jules-pr-review.yml` | `review`                                                                    | Third-party automated reviewer. Skipped for PRs that touch only `CLAUDE.md` / `AGENTS.md` / plan-and-spec directories, and for forks                                                     | PR opened / synchronized / reopened / ready-for-review against `main`                |

Two path-filter decisions are load-bearing and worth knowing:

- **`web.yml` has no path filter on purpose.** The web tree mirrors types that originate elsewhere in the repo, so narrowing the filter would let a break through from outside `src/web/`.
- **`raw-pipeline.yml` is path-filtered**, so a change confined to, say, `src/api/` never runs the colour harness. That is fine because nothing outside the Rust workspace and the harness scripts can move the pixels.

Every workflow except `deploy-hosted` cancels in-progress runs on non-`main` refs; pushes to `main` always run to completion so the branch signal stays accurate. `deploy-hosted` never cancels — a half-written blob container is worse than a superseded one.

---

## Fixtures and the skip-pass convention

Fixtures live in one shared `test-fixtures/` tree at the repository root, read by Rust, Apple, and the API alike.

| Path                                           | Committed? | Contents                                                           |
| ---------------------------------------------- | ---------- | ------------------------------------------------------------------ |
| `test-fixtures/raws/`                          | **No**     | Source RAWs (several GB), including the `pano_*/` multi-frame sets |
| `test-fixtures/references/<stem>/{down,full}/` | **No**     | ACR-rendered reference PNGs per case                               |
| `test-fixtures/references/manifest.json`       | **No**     | The case list the colour harness renders                           |
| `test-fixtures/references/film/`               | Yes        | Golden PNGs for the film-look ratchet                              |
| `test-fixtures/budgets.json`                   | Yes        | Per-fixture × per-case ΔE ceilings (20 fixtures, ~44 cases each)   |
| `test-fixtures/banding_budgets.json`           | Yes        | Second-difference and flat-run ceilings for the banding gate       |
| `test-fixtures/pano-budgets.json`              | Yes        | Per-set stitch ceilings and the coverage floor                     |
| `test-fixtures/face-clustering/`               | Yes        | ~2 MB synthetic embedding corpus + per-metric floors               |
| `test-fixtures/file-operations/cases.json`     | Yes        | Cross-platform file-operation parity corpus                        |
| `test-fixtures/filename-templates/cases.json`  | Yes        | Filename-template parity corpus                                    |
| `src/apple/MapleUITests/Fixtures/synthetic/`   | Yes        | A hand-rolled grey DNG plus six slider XMPs                        |

**Skip-pass** is the convention for everything that needs the gitignored RAWs: the script prints a "skipping" line and exits 0, so a clone without fixtures doesn't fail spuriously. Two refinements matter:

- **Fail-closed once fixtures are half-present.** `test_color_pipeline.sh` skips only at preflight (missing manifest or missing budgets). Once both exist it refuses to report green on zero comparisons — an empty candidate directory, an unresolvable RAW path, or a `FILTER` matching nothing exits non-zero rather than passing vacuously.
- **Ignored, not silently skipped, in Rust.** Fixture-dependent tests are marked `#[cfg_attr(not(feature = "fixtures"), ignore)]`, so on a stock runner they appear in the `ignored` count. With `--features fixtures` a missing file **panics** ([`raw-core/src/test_support/fixtures.rs`](../src/raw-pipeline/raw-core/src/test_support/fixtures.rs)) — broken provisioning fails loudly instead of no-opping.

The synthetic gates (grey, colour chart, banding) synthesise their inputs in memory and therefore **never** skip. They are the strictest always-on regression net in the repo.

---

## Rust core

```bash
cd src/raw-pipeline

# What CI runs: lib + integration targets, fixture tests visibly ignored.
cargo test -p raw-core --features test-support

# On a fixture-provisioned machine: the ignored tests run, and a missing file panics.
cargo test -p raw-core --features test-support,fixtures

# The FFI shim (pointer/geometry guards, encode contract, develop-preview parity).
cargo test -p raw-ffi --lib
cargo test -p raw-ffi --test develop_preview_parity
cargo fmt --check -p raw-ffi        # raw-ffi is rustfmt-canonical; the rest of the workspace is not

# Golden tests that shell out to compare_images.py — opt-in, needs Python + fixtures.
cargo test -p raw-core --features golden golden -- --nocapture --test-threads=1
```

Cargo features on `raw-core` that change what gets tested:

| Feature        | Effect                                                                                        |
| -------------- | --------------------------------------------------------------------------------------------- |
| `test-support` | DNG-synthesis helpers. Required by every `tests/*.rs` integration target. Never ship it.      |
| `fixtures`     | Un-ignores the fixture-gated tests and makes a missing fixture a panic.                       |
| `golden`       | Enables `tests/golden.rs`, which renders a fixture and shells out to `compare_images.py`.     |
| `stage-dump`   | Writes one OpenEXR per pipeline stage to `$MAPLE_STAGE_DUMP`. Adds ~2 MB; diagnostics only.   |
| `gpu`          | Pulls in the `raw-gpu` crate (wgpu/WGSL). Off by default so CPU-only builds don't carry wgpu. |

The integration targets under `raw-core/tests/` are the synthetic gates' entry points: `grey_invariants`, `grey_adjustments`, `grey_adjustments_display`, `grey_dcp_phase1`, `color_chart_invariants`, plus `golden` and the ACR-fitting helpers.

The `build-raw-ffi` job also compile-gates `cargo build --bin maple-cli --features pano`, which is the only always-on CI step that compiles `maple-pano` with its ML stack.

---

## The colour harness

[`src/scripts/test_color_pipeline.sh`](../src/scripts/test_color_pipeline.sh) is the canonical perceptual gate.

```bash
src/scripts/test_color_pipeline.sh                      # full manifest
FILTER=test_0000 src/scripts/test_color_pipeline.sh     # one fixture
FILTER=baseline  src/scripts/test_color_pipeline.sh     # one case across fixtures
PREFERRED_RES=full src/scripts/test_color_pipeline.sh   # full-res references
```

It builds `maple-cli` in release (unconditionally — cargo's own fingerprint is the staleness check, so a stale prebuilt binary can't silently report old results), runs `maple-cli batch <manifest> --out-dir <tmp>` once for all cases, Lanczos-resizes each candidate to the reference's dimensions, and diffs in-process using `compare_images.py`'s `diff()`. Output is a column-aligned table sorted by fixture and case, with per-fixture and grand-mean aggregates.

The metric, from [`compare_images.py`](../src/scripts/compare_images.py): mean / p95 / max CIEDE2000 plus per-channel bias (`bias_r`, `bias_g`, `bias_b`). `--zones` adds a shadow/mid/highlight breakdown keyed on the reference's L\*; `--hue-bins N` adds per-hue-angle deltas with low-chroma pixels routed to a neutral bucket. Python deps are pinned in `src/scripts/requirements.txt` (numpy, Pillow, colour-science, scipy, tifffile).

Useful environment overrides: `MAPLE_CLI` (use a prebuilt binary, skipping the build), `MANIFEST`, `BUDGETS`, `KEEP_TMP`, and `ALLOW_MISSING_BUDGET` (by default a case with no budget entry **fails**, which is what forces new cases to be budgeted).

### The one-way ratchet

`test-fixtures/budgets.json` holds a `{version, fixtures: {<fixture>: {<case>: {mean, p95, max, bias}}}}` table. All four metrics are ceilings, so lower is stricter. **Budgets only go down**, and a budget drops in the same commit that delivers the improvement.

[`tools/check_budget_ratchet.py`](../tools/check_budget_ratchet.py) is the gate. Per cell present on the base branch: a raised ceiling fails, and a _removed_ cell fails too (dropping a budget silently drops its gate). New cells pass — adding coverage is the ratchet turning the right way. CI resolves the PR merge base, `git show`s that revision's `budgets.json`, and diffs:

```bash
python3 tools/check_budget_ratchet.py --self-test                    # runs unconditionally in CI
python3 tools/check_budget_ratchet.py --base <old.json> --head test-fixtures/budgets.json
```

[`test-fixtures/BUDGETS_DRIFT.md`](../test-fixtures/BUDGETS_DRIFT.md) is the log of budgets that are knowingly held rather than re-baselined — currently fourteen cases across `test_0013` and `test_0018` whose ceilings are frozen at values the harness still breaches, deliberately keeping those rows red rather than papering over a real systematic shift.

**Re-baselining (#2335).** A raise is not always a regression: a legitimate re-capture against a changed default pipeline can ratchet most cells down while genuinely raising a few (#814: 218 down, 41 up), and the gate above has no way to let those 41 through short of disabling the whole required check — which would leave no record at all. Instead, cover each raised cell with a `RE-BASELINE:` marker line, one per cell, in the PR body or the head commit's own message (either is scanned; the commit message is the one that survives "Rebase and merge" into `main`'s permanent history, since the PR body itself does not):

```
RE-BASELINE: test_0013/baseline.max: retuned AgX sigmoid, see #814
RE-BASELINE: test_0018/baseline_auto.p95: same retune, see #814
```

A marker with no justification text after the second colon does not count — the raise it would have covered still fails the gate. Every accepted marker is echoed to the CI log (`N audited RE-BASELINE raise(s)`) so the exception is visible next to the run, not just buried in the PR description; a raise still fails if no marker names its exact `<fixture>/<case>.<metric>` cell. Markers only ever excuse a _raise_ — a removed cell fails regardless, same as always.

### Adding a case

1. Render the ACR reference to `test-fixtures/references/test_NNNN/down/<case>.png`.
2. Add the case to `test-fixtures/references/manifest.json`.
3. Run the harness — it fails with `no-budget-entry`.
4. Take the printed `mean / p95 / max / bias` and add a budget entry with roughly 5–10% headroom, or pipe the captured table through [`tools/budget_init.py`](../tools/budget_init.py), which does exactly that (`ceil(x * 1.05)` with floors of 0.5 / 1.0 / 1.0 / 0.005) and emits JSON.
5. Commit the reference, the manifest entry, and the budgets entry together.

`budget_init.py` parses both PASS and FAIL rows, so it is usable on the red run a re-baseline is captured from.

### P3 primaries (#1339, P3 phase 3)

ACR references are sRGB. Once `maple-cli render --target-primaries p3` renders true Display P3 (#1337), the harness can't diff that candidate against an sRGB reference directly — saturated colours would read as "out of budget" everywhere purely from the primaries mismatch, not a real pipeline error. The strategy: render in the target colourspace, **rotate the candidate back to sRGB before the diff**. Same references, same metric — no separate P3 reference set, since the rotation is exact linear-algebra (not a perceptual step), so nothing is lost going through it.

The plumbing landed in this PR — `maple-cli render`/`batch --target-primaries {srgb,p3}` (default `srgb`, byte-identical to the historical behaviour) and `compare_images.py`'s `diff(..., source_primaries="srgb"|"p3")` / `--source-primaries` / `maple-cli diff --source-primaries` — but **no manifest cases or `budgets.json` entries were added**. `test-fixtures/BUDGETS_DRIFT.md` already carries fourteen cases held red pending #814's re-baseline; seeding P3 budgets before that lands would inherit the same unresolved baseline. Adding P3 cases to `test_color_pipeline.sh`'s manifest is a follow-up once #814 is closed, using the same [Adding a case](#adding-a-case) steps above with `--target-primaries p3` on the render side and `--source-primaries p3` on the diff side.

The rotation itself: `pixels_srgb = M_P3→sRGB · pixels_p3`, applied in linear light (decode the shared sRGB OETF, rotate, re-encode) via `compare_images.py`'s `p3_to_srgb_primaries`, where `M_P3→sRGB = inv(M_SRGB_TO_P3)` and `M_SRGB_TO_P3` is copied verbatim from [`raw-core/src/color/matrices.rs::M_SRGB_TO_P3`](../src/raw-pipeline/raw-core/src/color/matrices.rs) — the same matrix `rec2020_to_display(TargetPrimaries::P3)` rotates through, not an independently-derived equivalent. Verify the rotation in isolation, no fixtures or references needed:

```bash
python3 src/scripts/compare_images.py --self-test
```

It checks: the two matrices are true inverses; white round-trips exactly (P3 and sRGB share the D65 white point); a synthetic in-gamut patch round-trips sRGB → P3 → sRGB within float rounding noise; an out-of-sRGB-gamut P3 primary clips into `[0,1]` without NaN; and — through the real `diff()` entry, with two temporary PNGs — a P3-rotated candidate against its own sRGB source reads near-zero ΔE while the same pair diffed *without* the rotation reads far worse, proving the flag is actually wired into the comparison, not just correct in isolation.

---

## Per-domain pipeline gates

| Script                                                                          | Gate?                                  | Inputs                         | In CI                     |
| ------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------ | ------------------------- |
| [`test_synthetic_grey.sh`](../src/scripts/test_synthetic_grey.sh)               | Yes, never skips                       | In-memory DNG                  | `rust-tests`              |
| [`test_synthetic_color_chart.sh`](../src/scripts/test_synthetic_color_chart.sh) | Yes, never skips                       | Synthetic 24-patch chart       | `rust-tests`              |
| [`test_grey_adjustments.sh`](../src/scripts/test_grey_adjustments.sh)           | Yes, never skips                       | In-memory DNG                  | `rust-tests`              |
| [`test_grey_dcp.sh`](../src/scripts/test_grey_dcp.sh)                           | Yes, never skips                       | In-memory DNG                  | `rust-tests`              |
| [`test_banding.sh`](../src/scripts/test_banding.sh)                             | Yes; tail section skips without a RAW  | Synthetic ramps                | `rust-tests`              |
| [`test_color_pipeline.sh`](../src/scripts/test_color_pipeline.sh)               | Yes; skips at preflight                | RAWs + ACR refs                | `color-pipeline`          |
| [`test_pano_pipeline.sh`](../src/scripts/test_pano_pipeline.sh)                 | Partly (see below)                     | `raws/pano_*/` sets            | `pano-pipeline`           |
| [`test_film_looks.sh`](../src/scripts/test_film_looks.sh)                       | Yes; skips without the RAW or LUT pack | `test_0017.dng` + `.mlut` pack | **not in CI**             |
| [`test_face_clustering.sh`](../src/scripts/test_face_clustering.sh)             | Yes                                    | Committed JSONL corpus         | `face-clustering-quality` |
| [`test_search_relevance.sh`](../src/scripts/test_search_relevance.sh)           | Yes; skips without sidecars            | Committed query corpus         | **not in CI**             |
| [`test_auto_profile_match.sh`](../src/scripts/test_auto_profile_match.sh)       | Yes; skips without RAWs                | RAWs + embedded JPEGs          | **not in CI**             |
| [`check_wgsl.sh`](../src/scripts/check_wgsl.sh)                                 | Yes                                    | WGSL sources                   | `raw-gpu`                 |
| [`test_halo_detection.sh`](../src/scripts/test_halo_detection.sh)               | Diagnostic only                        | Synthetic disk                 | **not in CI**             |
| [`test_hue_stability.sh`](../src/scripts/test_hue_stability.sh)                 | Diagnostic only                        | Synthetic primaries            | **not in CI**             |
| [`test_stage_diagnostic.sh`](../src/scripts/test_stage_diagnostic.sh)           | Diagnostic only                        | Committed grey DNG             | **not in CI**             |
| [`test_backup_smoke.ts`](../src/scripts/test_backup_smoke.ts)                   | Manual smoke test                      | A running API + Mongo          | **not in CI**             |

Notes on the ones with unusual shapes:

- **Banding.** `test_banding.sh` sweeps a neutral ramp plus four constant-hue Oklab chroma ramps, at seven slider extremes, through _two_ stages (the AgX gamut compress and the Rec.2020→sRGB display-encode compress) — either can regress independently. The metric is a second-difference spike, not first-difference monotonicity; `banding_check.py` carries the reasoning. Ceilings live in `banding_budgets.json` and are re-derivable with `BUDGET_INIT=1`. A trailing section fits the shipping Auto Profile tail from a real RAW and gates spike _and_ flat-run (posterization) budgets — that part skips when the RAW is absent.
- **Pano.** Two things always run, fixtures or not: the budgets file must parse with the expected shape, and `pano_metrics.py --self-test` validates the metric implementation procedurally. Set discovery and the per-set gates activate only with `raws/pano_*/` present. Gated keys include `rmse`, `seam_energy`, `wrap_closure_px`, `mean_reproj_px`, and `coverage` — the last is a **floor**, breaching when it falls below its budget.
- **Film looks.** A self-consistency ratchet, not an ACR comparison: each catalog look is rendered and diffed against a committed golden with tight budgets (mean ≤ 0.5, max ≤ 2.0 ΔE₀₀). A missing golden writes the baseline and fails with "baseline written" — eyeball it, then re-run. It also renders a no-look control and asserts every look differs from it by more than 0.5 mean ΔE₀₀, so a LUT that resolves to a no-op fails loudly instead of passing against its own inert baseline.
- **Search relevance.** Measures Recall@10, MRR, and per-query rank guards against the corpus in `src/api/tests/fixtures/search-relevance/`. It needs a real Meilisearch _and_ a real Ollama with `bge-m3` pulled; both URLs unset means exit 0.
- **Face clustering.** Runs the pure `clusterEmbeddings` function over the committed JSONL corpus and gates purity / NMI / V-measure / ARI / recall@1 against per-metric floors. No Mongo needed — the CI job doesn't even run `bun install`, because the harness imports only dependency-free modules.

---

## GPU parity

CPU↔GPU agreement is a real gate, and it runs on a **software** Vulkan adapter. The `raw-gpu` job installs `libvulkan1` + `mesa-vulkan-drivers` (lavapipe) on a stock Ubuntu runner, verifies `vulkaninfo --summary` enumerates a device (failing the job outright if it doesn't), then runs four gates cheapest-first:

```bash
cargo build -p raw-ffi --features gpu                      # the FFI GPU surface compiles
cargo check -p raw-wasm --all-features --all-targets       # raw-wasm's gpu module tree type-checks
cargo install naga-cli --locked --version 23.0.0
bash src/scripts/check_wgsl.sh                             # naga front-end + validator, no GPU needed
cargo test -p raw-gpu                                      # every WGSL kernel vs its raw-core Rust stage
cargo test -p raw-wasm --features gpu                      # render_bytes_gpu vs render_bytes
```

`check_wgsl.sh` exists because naga has no `#include` but the Rust pipeline accessors assemble kernels by prepending generated headers (`generated/color_matrices.wgsl`, `generated/agx_coeffs.wgsl`). It validates each kernel under a ladder of header prefixes — standalone, with matrices, with matrices plus AgX coefficients — and passes if any rung validates, so a kernel calling `mul_rec2020_to_srgb` isn't a false "unknown identifier". naga-cli is pinned to the version wgpu bundles so the gate matches the compiler the app runs.

The job sets `MAPLE_REQUIRE_GPU=1`, which turns raw-wasm's developer-friendly "no adapter, skipping" soft-pass into a panic. On a runner deliberately provisioned with an adapter, a skip is a broken gate, not a valid outcome.

**What this does not cover:** lavapipe is a Vulkan/SPIR-V target, so the gate proves raw-core↔WGSL agreement but says nothing about the Metal backend (naga's MSL output, Apple driver rounding) or a browser's real WebGPU implementation. Those are only exercised on real hardware — locally, and through the Apple UITest harness.

---

## Apple

```bash
# Prerequisite in any fresh clone: the xcframework's .a files are gitignored.
./src/apple/scripts/build-xcframework.sh          # --debug for fast iteration

# Package unit tests (the substantive Apple test surface).
cd src/apple/Packages/MapleCore && swift test
cd src/apple/Packages/MapleUI   && swift test
cd src/apple/Packages/MapleBackup && swift test

# Xcode targets. The "Maple Exposure" scheme carries MapleTests and MapleUITests.
xcodebuild test -project src/apple/Maple.xcodeproj -scheme "Maple Exposure" \
  -destination 'platform=macOS' -only-testing:MapleUITests \
  MAPLE_UITEST_FIXTURE_ROOT="$PWD/test-fixtures/raws"
```

Three local packages hold most of the code: `MapleCore` (roughly 280 test files, covering the pipeline wrapper, sidecar store, sources, auth, and view models), `MapleUI` (the dependency-free design system — its component tests mirror the contracts in `docs/design/maple-ui/components/`), and `MapleBackup`. The Xcode project adds `MapleTests` (view-model unit tests) and `MapleUITests` (live-UI visual harnesses); both are in the shared `Maple Exposure` scheme.

The visual harnesses in `src/apple/MapleUITests/` all follow one shape: stage a temp directory with a RAW plus a renamed `.xmp`, launch the app with `MAPLE_UITEST_FIXTURE` set, wait for the `canvas-render-ready` accessibility identifier to flip once the refine pass publishes, screenshot the canvas, and compare numerically.

| Test class             | What it proves                                                                                                                                                                                                         |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MapleUITests`         | One fixture at default settings vs a committed golden (`Goldens/test_0017-default.png`). Budgets: mean ≤ 5, p95 ≤ 10, max ≤ 30, bias ≤ 0.05. Deleting the PNG re-records it and fails with "baseline written"          |
| `SliderMatrixUITests`  | Every committed slider XMP under `references/<stem>/xmp/` vs its ACR render. Both sides resized to a 1024px long edge. Budgets are loose (Maple's AgX view transform differs from ACR's) and failures attach both PNGs |
| `SyntheticGreyUITests` | The Apple path (Rust FFI scene-linear → Metal AgX → Metal sRGB encode) lands on the same grey the Rust CPU tail produces: every pixel neutral within ±2 LSB, canvas mean within ±3 LSB of six per-case expected values |
| `CIEDE2000Tests`       | Cross-validates the Swift ΔE₀₀ port against `compare_images.py` on a committed calibration PNG pair                                                                                                                    |

Fixture-dependent classes call `XCTSkip` when the RAW isn't present, mirroring the shell harnesses.

### What CI actually builds for Apple

`apple.yml` is a **compile gate only**: `swift build` of the MapleCore package on `macos-15`. It stages a cbindgen-generated `RawPipeline.h` into every xcframework slice and fabricates an empty stub `libraw_ffi.a`, because SwiftPM validates that a binary target's archive exists but never links a static library into a _library_ target. That is enough to catch the recurring failure class — a codegen-added enum case landing beside an exhaustive switch that never gained an arm — without a tens-of-minutes Rust cross-build. `cbindgen` is pinned to 0.29.2 here and in `ci_scripts/ci_post_clone.sh` so generated headers can't drift between the two CIs.

**No cloud CI runs Apple tests.** `swift test`, the UITest harnesses, and the app-target build all happen locally or on Xcode Cloud. Xcode Cloud's workflows are configured in App Store Connect, not in this repo; the only repository-side hook is [`src/apple/ci_scripts/ci_post_clone.sh`](../src/apple/ci_scripts/ci_post_clone.sh), which installs Rust via Homebrew (with retry/backoff around the worker pool's flaky DNS), adds the four Apple targets, installs the pinned cbindgen, and runs `build-xcframework.sh --release` so the archive has real static libs to link.

Per-slice symbol staleness — the "device link fails with `Undefined symbols: _maple_…`" class — is guarded inside `build-xcframework.sh` itself, which derives the expected symbol set from the generated header and checks every slice's archive, with explicit exception lists for iOS-only and Windows-only externs.

**First run on a fresh Mac:** the UI test runner triggers a keychain/TouchID prompt. Run the test once through Xcode interactively to authorize it; subsequent CLI runs reuse the cached credential. There is no headless workaround.

---

## Web

```bash
cd src/web

# Required once per fresh clone/worktree — pkg/ is gitignored and `test` has no pretest hook.
bun run raw-wasm            # build-raw-wasm (nightly + -Z build-std) then sync into maple-common

bun x ng test maple         # the editor app suite  (what CI runs)
bun x ng test Maple-common  # the shared library suite — note the capital M
bun run format:check        # local mirror of the CI prettier gate
bun run e2e                 # Playwright against `ng serve maple-syrup` on :4200
bun run e2e:production      # Playwright against real production bundles
```

Unit tests use Angular's `@angular/build:unit-test` builder (vitest under the hood) for all three projects. CI runs `maple` and `Maple-common`; **`maple-syrup` has a `test` target that no workflow invokes.**

The `web-build` job is heavier than a plain compile because the app imports the Rust→WASM `pkg/`, which is a gitignored build artifact. It provisions nightly Rust (pinned `nightly-2025-10-01` + `rust-src` + `wasm32-unknown-unknown`) and wasm-pack, runs `bun run raw-wasm` explicitly so the `prebuild` lifecycle hook no-ops off the stamp, and only then builds. A bare `wasm-pack build --target web` is not equivalent: the crate needs `-Z build-std` for its atomics/bulk-memory target features, `initThreadPool` exists only with `--features parallel`, and the WebGPU live entry only with `--features gpu`.

Beyond the two builds, `web-build` runs five contract checks and one browser suite:

| Step                                | What it enforces                                                                                                                                                      |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run brand:check`               | The brand assets under `maple-common` still match the Apple asset catalog (icon hashes pinned)                                                                        |
| `bun run check:hosted-artifact`     | The built Hosted bundle contains the required icons, local fonts, and WASM assets, keeps the app shell under 8 MB, and its `ngsw.json` asset groups are intact        |
| `bun run check:hosted-capabilities` | No server-only route string (`/api/fs/list`, `/api/pano/stitch`, `/workers/status`, …) leaked into the Hosted bundle, and the main chunk stays under its byte ceiling |
| `bun run maple-ui:adoption-check`   | A raw `<button>` or a `btn-primary`/`btn-ghost` class has not re-entered a directory already migrated to the Maple UI components — an adoption ratchet                |
| `bun run e2e:production-artifacts`  | Four Playwright specs (brand assets, service worker, service-worker update, welcome intake) against real built bundles in installed Google Chrome                     |

The full production Playwright suite (`e2e/production/`, fifteen specs covering accessibility, editor interactions, RAW performance and reliability, origin switching, self-hosted persistence) runs from two locally served bundles — Hosted on `:4400`, self-hosted on `:4401` — and is **not** wired into CI; only the four-spec artifact subset is. The dev-server e2e suite (`e2e/*.spec.ts`) is Chromium-only, because the RAW decode path needs `crossOriginIsolated` and only the ng-serve config sets COOP/COEP.

Storybook builds (`bun run build-storybook`) exist for the `maple` project but no workflow runs them. Bundle size is gated two ways: Angular's own budgets in `angular.json` (initial bundle warns at 3 MB, errors at 8 MB; any component stylesheet warns at 8 kB, errors at 16 kB) and the tighter hand-written ceilings in the Hosted artifact/capability checks.

---

## API

```bash
cd src/api
bun install
bun test                 # the whole suite, 20s timeout
bun run typecheck        # tsc --noEmit — advisory, not a CI gate
bun run lint             # oxlint src — this IS a CI gate (cross.yml)
```

CI stands up two real services rather than mocking them: `mongo:7` on 27017 and `getmeili/meilisearch:v1.50.0` on 7700. The main step runs `bun test --timeout 30000` with `MAPLE_MONGO_URI` and a throwaway `MAPLE_JWT_SECRET`; a second step runs `src/enrichment/meilisearch-real.integration.test.ts` with `MAPLE_MEILISEARCH_INTEGRATION_URL` set, which is what un-gates it.

Mongo-backed suites **skip-pass when Mongo is unreachable** — each connects with a 1.5s server-selection timeout and, on failure, closes the half-open client and marks itself unreachable. So `bun test` on a laptop without Mongo is green but has proven much less than CI did.

Database naming is the subtle part. Bun evaluates every module body during the import phase, before any test runs, so a suite that assigns `process.env.MAPLE_MONGO_DB` at module scope renames the database for the whole process: the last import wins, other suites' `getDb()` connect to it, and one suite's teardown can drop a database another is still using. The fix is [`src/api/src/db/test-db.test-helpers.ts`](../src/api/src/db/test-db.test-helpers.ts):

```ts
const TEST_DB = withTestDb(`maple_test_assets_overrides_${process.pid}`);
```

`withTestDb` wraps `withTestEnv`, which claims the value in a root `beforeAll` and restores the prior value in `afterAll`. Because it registers the restore _first_, teardown runs before the suite's own `afterAll` — which is why a suite that drops its database must capture the `Db` handle in `beforeAll` and drop _that_, never re-read `getDb()` at teardown. The `${process.pid}` suffix keeps concurrent runs from colliding.

[`src/scripts/test_backup_smoke.ts`](../src/scripts/test_backup_smoke.ts) is a twelve-step manual end-to-end check of the PhotoKit backup endpoints — chunked ingest, sidecar upload, rendered companion, reconciliation feed, deletion notification, then cleanup. It needs a running API and Mongo, and is not part of any workflow.

---

## Windows

`windows.yml` is the only workflow that builds anything Windows-specific, and it does five things on a `windows-latest` runner: `cargo check` of `raw-core` and `raw-ffi --features gpu` for the MSVC target, `cargo test -p raw-core --lib` (a second architecture for the core's unit tests), `cargo build --release` of the `maple-windows` host crate, `dotnet build` of `Maple.WinUI` for `win-x64`, and `dotnet test` of `Maple.WinUI.Tests`. It then re-runs `tools/codegen.sh` to prove the generator works on Windows too.

The WinUI test project is substantial and mostly logic-level: reducers, math helpers, and file-operation logic extracted from the views so they can be tested without a UI host — including a large `Mui*` set mirroring the shared design system's components.

---

## Cloudflare Worker

The thumbnail-cache Worker in `src/cloudflare/` is a standalone deploy unit with no shared imports into `src/api` or `src/web`, which is why its workflow can safely be path-scoped.

```bash
cd src/cloudflare
npm ci
npm run cf-typegen     # regenerates the gitignored worker-configuration.d.ts
npm run typecheck
npm test               # vitest via @cloudflare/vitest-pool-workers
```

It uses Node and npm rather than Bun — deliberately. `@cloudflare/vitest-pool-workers` bridges the test runner and the worker isolate over a WebSocket, and Bun's implementation doesn't fire the `upgrade` event that bridge needs, so `bun run test` hangs indefinitely on this package specifically.

`wrangler.jsonc` is gitignored (it holds per-operator values), so CI copies `wrangler.jsonc.example` into place — structurally valid, never deployed. There is no auto-deploy job; operators run `npm run deploy` from their own machine. Test secrets are injected through the miniflare bindings in `vitest.config.ts`, not a `.dev.vars` file.

---

## Cross-surface parity corpora

Some behaviour is implemented independently in three or four languages and can't be shared as code. Those cases are pinned as declarative JSON corpora, replayed by each language's own runner against its own primitives — proving identical _outcomes_ without shared implementation.

| Corpus                                        | Replayed by                                                                                                                                                             |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test-fixtures/file-operations/cases.json`    | `src/api/src/fs/relocate.parity.test.ts`, `src/apple/…/MapleCoreTests/FileOperations/RelocateParityTests.swift`, `src/windows/Maple.WinUI.Tests/RelocateParityTests.cs` |
| `test-fixtures/filename-templates/cases.json` | `src/raw-pipeline/raw-core/src/filename/tests_fixtures.rs`, `src/apple/…/MapleCoreTests/FilenameTemplateEngineTests.swift`                                              |

Two rules the file-operations corpus states explicitly, and every runner honours: each runner **must** assert `schema_version` before running a single case (a mismatch is a hard failure, not a warning), and a case whose `requires` capability the platform lacks **must** be skipped with a printed message naming the case and the missing capability. A silently-omitted case is worse than no case at all.

---

## Repo tooling gates

These are the eleven `cross.yml` jobs. Everything here runs on every push to `main` and every PR, with no path filter; two are PR-only because they need a merge base to diff against.

| Job                                | What it does                                                                                                                                                                                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `format-check`                     | `prettier --check` over prettier-eligible files changed vs the merge base (or the pushed range), excluding `test-fixtures/`, `node_modules/`, `dist/`, and the vendored crate sources. Paths are NUL-delimited so asset-catalog names with spaces survive                       |
| `oxlint-api`                       | `bunx oxlint src` in `src/api` — correctness rules plus an import guardrail                                                                                                                                                                                                     |
| `file-budget`                      | `bash tools/check-file-budget.sh` — 400 LOC soft (warn), **600 LOC hard** (fail) over `.rs .swift .ts .tsx .js .py .cs`, minus `tools/budget-allowlist.txt`                                                                                                                     |
| `budget-headroom` (PR only)        | `bash tools/check-budget-headroom.sh origin/<base>` — fails if the PR **grows** a changed file past 570 LOC. Shrinking is always allowed                                                                                                                                        |
| `allowlist-shrinks-only` (PR only) | The LOC allowlist may not gain entries for a file extension it already covers at the merge base (per-extension, not a flat count — #2747). A language newly brought under the gate may seed its own day-0 violators once; split the file instead of allowlisting further growth |
| `budgets-ratchet-shrinks-only`     | `check_budget_ratchet.py --self-test` always; the merge-base diff on PRs                                                                                                                                                                                                        |
| `codegen-drift`                    | Runs `tools/codegen.sh`, then `git add -N . && git diff --exit-code` so a newly emitted untracked file can't slip past                                                                                                                                                          |
| `maple-ui-contracts`               | `tools/check-maple-ui-contracts.sh` (preceded by its own self-test) — every `docs/design/maple-ui/components/*.md` carries a `**Tier:**` line and non-empty `Purpose`, `Variants`, `States`, `Tokens used`, `Props`, `Accessibility` sections                                   |
| `fallow-audit-web`                 | `fallow audit --base origin/<base>` over `src/web` — dead code, complexity, duplication; fails only on findings the changeset _introduces_                                                                                                                                      |
| `fallow-audit-api`                 | Same over `src/api`. `.fallowrc.json` declares the Bun child-process entry points that `Bun.spawn` wires up by dynamic path and static analysis can't see                                                                                                                       |
| `gitleaks`                         | Pinned 8.21.2, installed from GitHub releases with double SHA-256 verification, scanning only this PR/push's own commit range so deep history is never re-flagged                                                                                                               |

Why 570 exists alongside 600: splitting a file to clear the hard ceiling naturally lands it at 598 or 599, because that is the cheapest change that turns CI green. The next unrelated PR adding two lines is then the one that fails, and the two never conflict textually so neither author is warned. The headroom gate charges the PR that _consumes_ the margin. **When you split a file, split it with real margin.**

The codegen gate matters because every constant appearing in more than one language is single-sourced from `raw-core` and emitted by the `codegen` crate: Swift `let`s, TypeScript `export const`s, SCSS tokens, XAML tokens, and WGSL consts. When a matrix or schema changes, run `bash tools/codegen.sh` and commit the regenerated files.

---

## Local pre-commit hooks

`lefthook.yml` installs graceful pre-commit checks — if a formatter isn't installed locally the step soft-skips with a notice, because CI is the gate and hooks are the early-warning system.

```bash
brew install lefthook    # or: npm i -g lefthook
lefthook install         # once per clone
```

Staged-file hooks: oxlint (`src/api/src/**/*.ts`), the file-size budget, prettier, `rustfmt --edition 2021 --check`, `swift-format lint --strict`, `ruff format --check` + `ruff check`, and `shfmt -d`. A `commit-msg` hook enforces Conventional Commits (`feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`), passing `Merge`/`Revert`/`fixup!`/`squash!`/`amend!` lines through unchanged.

---

## Diagnostics — not gates

These print numbers and exit 0. Reach for them when a gate goes red and you need to localise the change to a stage.

```bash
# Per-stage OpenEXR dumps + per-channel stats (min/max/mean, out-of-gamut counts, achromatic drift).
bash src/scripts/test_stage_diagnostic.sh                    # defaults to the committed grey DNG
FIXTURE=/path/to.dng OUT_DIR=/tmp/dump bash src/scripts/test_stage_diagnostic.sh

# ΔE₀₀ between two stage-dump trees — localises divergence to one stage.
python3 src/scripts/stage_diff.py <dirA> <dirB>

# Halo overshoot at a synthetic disk edge, for clarity / texture / dehaze.
bash src/scripts/test_halo_detection.sh

# Hue drift across exposure: six primaries × six EVs = 36 renders.
bash src/scripts/test_hue_stability.sh

# Per-stage RGB trace at one pixel, and raw-value statistics vs the declared white level.
cargo run --release -p raw-core --example stage-trace -- <DNG> <X> <Y>
cargo run --release -p raw-core --example raw-stats   -- <DNG>
```

All of the stage-dump paths need `maple-cli` built with `--features stage-dump`; the scripts handle that themselves and exit non-zero only on a toolchain failure — a build failure, a render failure, or zero EXRs emitted (which usually means the feature flag was missing).

`banding_check.py`, `stage_stats.py`, `stage_diff.py`, and `pano_metrics.py` all carry their own unit tests, and CI runs them in the `rust-tests` and `pano-pipeline` jobs — the measurement tools are gated as carefully as the thing they measure.
