# Testing and CI

Maple's test surface has three layers. **Unit and integration tests** run per language in their own toolchain (`cargo test`, `swift test`, `bun test`, `ng test`, `dotnet test`, `vitest`). **Harness gates** are shell scripts under `src/scripts/` that render images through the real pipeline and compare them numerically — against camera embedded JPEGs, committed Maple goldens, or closed-form predictions — with per-case ceilings stored in JSON files that may only ever get stricter. **Repo tooling gates** under `tools/` guard cross-cutting invariants: file size, generated-code drift, budget ratchets, component-contract docs. GitHub Actions workflows wire these into CI; a few of the heaviest harnesses depend on RAW fixtures that are gitignored, so they deliberately no-op on a stock runner and only become meaningful on a fixture-provisioned machine.

The rule that shapes everything colour-related: **no eyeballing**. A screenshot comparison is never acceptable evidence for a pipeline change. The number that counts is CIEDE2000 (ΔE₀₀) plus per-channel bias, produced by one shared implementation in [`src/scripts/compare_images.py`](../src/scripts/compare_images.py).

---

## CI workflows

The table below summarizes test and review workflows in [`.github/workflows/`](../.github/workflows/); release and version-management workflows also live there. Workflow definitions describe execution, not the current GitHub branch-protection settings. The repository merge contract requires green checks **on the current tip of `main`**: a branch whose base has moved needs a rebase and fresh checks. Optional jobs are identified explicitly below; a successful workflow summary alone does not prove that every suite executed.

| Workflow              | Job(s)                                                                                                                    | What it actually runs                                                                                                                                                                                                                                                                                                                                                                  | Trigger                                                                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cross.yml`           | Repo tooling, release/CI regression tests, selection and result jobs                                                      | prettier, oxlint, file budgets, budget ratchets, codegen drift, dead-code audits, secret scan, UI contract docs, editor parity manifest                                                                                                                                                                                                                                                | every push to `main` + every PR; expensive jobs selected by dependencies                                                                                                                            |
| `web.yml`             | `build-wasm`, `web-build`, `web-test`, `web-test-common`, `web-webgpu-smoke`, `web-workflow-acceptance`, selection/result | One shared WASM build; Angular builds and unit suites, artifact/capability/adoption checks and Playwright; optional fixture-gated WebGPU smoke                                                                                                                                                                                                                                         | every push to `main` + every PR; jobs selected by dependencies                                                                                                                                      |
| `maple-types.yml`     | `maple-typecheck`                                                                                                         | Strict package source and test typechecks using the frozen API dependency lock; no native library or image fixtures required                                                                                                                                                                                                                                                           | every push to `main` + every PR + `workflow_dispatch`                                                                                                                                               |
| `api.yml`             | `api-typecheck`, `api-tests`                                                                                              | `bun run typecheck` for source and tests, then `bun test --timeout 30000` with no database service                                                                                                                                                                                                                                                                                     | every push to `main` + every PR + `workflow_dispatch`                                                                                                                                               |
| `raw-pipeline.yml`    | `build-raw-ffi`, `raw-gpu`, `raw-gpu-metal`, `rust-tests`, `color-pipeline`, `pano-pipeline`                              | FFI compile+test, GPU/WGSL parity on software Vulkan, GPU/WGSL parity on real Metal (non-required, #2315), fixture-free Rust tests + synthetic gates, Auto vs embedded-JPEG accuracy, the pano harness                                                                                                                                                                                 | pushes/PRs touching `src/raw-pipeline/**`, the harness scripts, or the budget JSONs                                                                                                                 |
| `apple.yml`           | `swift-build`, `swift-regressions`, `swift-regressions-coverage`                                                          | MapleCore compile gate, executable regressions against a real host Rust archive, and the run/excluded class-list gate                                                                                                                                                                                                                                                                  | every push/PR runs `changes`; the macOS jobs run only when `tools/ci_changes.py` selects `swift` (Apple source, raw-pipeline, shared fixtures, API fixtures Swift boots, recipe-interchange inputs) |
| `windows.yml`         | Wrapper contract, build/tests, selection/result                                                                           | Supported Windows wrapper build, raw-core tests, WinUI XMP/FFI-layout tests and real window-lifecycle smoke                                                                                                                                                                                                                                                                            | every push to `main` + every PR; jobs selected by dependencies                                                                                                                                      |
| `linux.yml`           | Native build/tests and archive                                                                                            | All-target Clippy, native library/integration tests serially on required software Vulkan, release binary and local-prefix archive; committed small fixtures, no physical-GPU or real-account qualification                                                                                                                                                                             | Linux/shared Rust, film assets, native fixtures/icon or workflow changes; manual dispatch                                                                                                           |
| `cloudflare.yml`      | `cloudflare-test`, `cloudflare-ssr-test`, `cloudflare-drive-connect-test`                                                 | Typecheck and Vitest for the thumbnail cache, Hosted SSR and Google Drive callback Workers                                                                                                                                                                                                                                                                                             | pushes/PRs touching `src/cloudflare/**` or this workflow                                                                                                                                            |
| `face-clustering.yml` | `face-clustering-quality`                                                                                                 | `src/scripts/test_face_clustering.sh`                                                                                                                                                                                                                                                                                                                                                  | pushes/PRs touching `src/api/src/people/**`, the script, or its fixtures                                                                                                                            |
| `deploy-hosted.yml`   | `build-and-deploy`                                                                                                        | Builds `maple-syrup` and uploads it to Azure Blob. **Publishing, not gating**                                                                                                                                                                                                                                                                                                          | pushes to `main` touching `src/web/**` or `src/raw-pipeline/**`; `workflow_dispatch`                                                                                                                |
| `jules-pr-review.yml` | `review`                                                                                                                  | Third-party automated reviewer. Skipped for PRs that touch only `CLAUDE.md` / `AGENTS.md` / plan-and-spec directories, and for forks. A reviewer infrastructure error, timeout or quota exhaustion reports `success` ("Review not blocking") on `review` and `jules/review`; a `VERDICT: block` still fails `jules/review`, and bad credentials or token permissions still fail loudly | PR opened / synchronized / reopened / ready-for-review against `main`                                                                                                                               |

### Dependency-aware CI selection

API, Web, Windows, Maple typechecks and expensive cross jobs use the reusable
`ci-changes.yml` workflow and `tools/ci_changes.py`. Their workflows still start
on every PR/main push; only unrelated jobs skip. Web selection includes API
types, Maple packages, shared Rust, and cross-tree assets rather than just
`src/web/`. Web source changes also select API tests because the API imports
Web's shared ID parser and checks its preset/adjustment data. Apple brand assets,
canonical presets, calibration fixtures and shipped component documentation
select their consumers too. Unknown paths run all optimized suites. Generated files select the
codegen drift check, even when the generator itself did not change.

PR selection uses the event's immutable base/head merge base; main pushes use
the entire before/after range. Deletes and both sides of renames count. Missing
history, invalid events and empty diffs conservatively run everything. Manual
runs and `release/next-v*` PRs retain full coverage. The workflow names
polled by Release readiness remain unchanged.

Each optimized workflow has an always-running result job using
`tools/ci_result.py`: selection must succeed, every selected required job must
succeed, and only explicitly unselected jobs may skip. The existing optional
WebGPU smoke remains non-blocking; an absent RAW fixture is reported as not
exercised before dependency/browser setup. It is not evidence of GPU parity.

Release regression tests run only for changes to `tools/release_*`,
`tools/test_release_*`, `tools/sync-release-version.sh`, or the release workflows.
CI selection regression tests run when CI configuration or shared tooling changes.
Unknown inputs, unavailable diffs and release PRs select all suites. Shared Rust
and fixture changes select the platform builds without unrelated release tests.
The NLM table test follows codegen selection, and the Swift test inventory follows
Swift selection. Formatting, secret scanning and repository budget checks remain
cross-cutting checks.

For ordinary PRs, `Release readiness` is skipped before allocating a runner;
release PRs still wait for the full release CI suite. Main requires the stable
`Android result`, `API result`, `Web result`, `Windows result`, `Maple types result`,
`Apple result`, and `Cross result` checks, plus `Release readiness` and
`release-handoff-complete`. These aggregate results validate selected successes
and intentional skips. Auto-merge waits for them without requiring ordinary PRs
to update to every new main commit. Release freshness remains enforced by the
handoff policy in `docs/releases.md`.

Web builds the canonical `gpu,parallel` WASM package once, shares it through an
artifact from the same workflow run, and syncs it into each consumer. The stamp
is refreshed after download so the existing build lifecycle hooks reuse that
package rather than recompiling it against checkout timestamps. Native package
validation covers every platform; Rust-source and calibration-fixture changes
trigger it directly as well as Maple package changes.

### Native package binary reuse

`publish-package.yml` may reuse the final FFI library and N-API addon for each
of its seven targets during ordinary PR validation. The exact cache key includes
tracked repository inputs (excluding `src/maple/` except its linkage audit),
target/platform, Rust/tool versions and runner image identity. Package-only
changes can therefore reuse native outputs; changes elsewhere conservatively
invalidate them. No prefix-key fallback is accepted.

The cache is restored into an isolated directory. `tools/native_package_cache.py`
checks the target, fingerprint, expected files and SHA-256 checksums before
copying either binary into the usual build output location. Missing, malformed
or corrupt entries fall back to compilation. Linux linkage audits, package
assembly, Bun tests and Node 22 acceptance still run against the current PR.

Only validation dispatched on `main` writes this binary cache, including the
release controller's reusable validation. PRs never save it. Tags, manual runs,
reusable release validation and `release/next-v*` PRs always invoke the native
builds; releases never consume this final-binary cache. Checksums detect damage,
not producer identity: GitHub cache scoping and the write restriction provide
the trust boundary. Initial runs rebuild until normal main validation populates
a matching entry; image/toolchain changes and cache eviction cause safe misses.

`raw-pipeline.yml` retains its existing path-filtered coverage; `apple.yml` uses the `swift` selection above, with `validation-result` as its fail-closed aggregate.
Release validation, tag publishing, Hosted deployment and Xcode Cloud are not
short-circuited by this selector. No tests are selected solely by their filename.

Selector, real Git-range, workflow-wiring, result-gate and Web-artifact tests:

```bash
python3 -m pip install PyYAML==6.0.2
python3 -m unittest discover -s tools -p 'test_ci_*.py'
```

Concurrency policies vary by workflow. The Apple, Rust and cross-cutting gates preserve pushes to `main` while cancelling superseded PR runs. A cancelled run is not passing evidence; use the current head’s completed results.

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

- **Fail-closed once fixtures are half-present.** `test_color_pipeline.sh` requires RAWs and measurable embedded-JPEG comparisons. Empty selections, render errors and zero comparisons fail; CI without physical fixtures reports NOT TESTED.
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
# ACR golden image tests are archived; use test_color_pipeline.sh for Auto accuracy.
```

Cargo features on `raw-core` that change what gets tested:

| Feature        | Effect                                                                                        |
| -------------- | --------------------------------------------------------------------------------------------- |
| `test-support` | DNG-synthesis helpers. Required by every `tests/*.rs` integration target. Never ship it.      |
| `fixtures`     | Un-ignores the fixture-gated tests and makes a missing fixture a panic.                       |
| `stage-dump`   | Writes one OpenEXR per pipeline stage to `$MAPLE_STAGE_DUMP`. Adds ~2 MB; diagnostics only.   |
| `gpu`          | Pulls in the `raw-gpu` crate (wgpu/WGSL). Off by default so CPU-only builds don't carry wgpu. |

The integration targets under `raw-core/tests/` are the synthetic gates' entry points: `grey_invariants`, `grey_adjustments`, `grey_adjustments_display`, `grey_adjustments_wb`, `grey_dcp_phase1`, `color_chart_invariants`, plus the solver math helpers (synthetic inputs, not Adobe image comparisons).

The `build-raw-ffi` job also compile-gates `cargo build --bin maple-cli --features pano`, which is the only always-on CI step that compiles `maple-pano` with its ML stack.

---

## The colour harness

`src/scripts/test_color_pipeline.sh` is the canonical Auto appearance gate.
It delegates to `test_auto_profile_match.sh`: each RAW is rendered with Auto
and compared against its own camera-embedded JPEG, never an Adobe render.
**Auto JPEG quality checks (#5000):** the old signed band means alone allowed
severe visible defects. The runner and direct comparator now ALSO require
non-cancelling full-frame/per-band RGB error at the JPEG grid, full-frame and
8-by-8 regional error at display scale, perceptual mean/tail color error,
clipping and gradient checks. Lens corrections remain enabled. A bounded
structural affine fit maps reference scene coordinates to the untouched candidate
grid. A radial residual is accepted only when spatially held-out landmark error
improves by at least 25%, bidirectional coverage still passes, and the mapping
has no folds or displacement exceeding the existing 10% geometry bound.
OpenCV SIFT supplies mutual landmarks; selection never uses color scores.
No evaluated colors, exposure or contrast are fitted. Only coordinates
outside the geometric overlap are excluded. Both image directions must retain
95% overlap and every 8-by-8 tile must retain 75%; insufficient support or
structural confidence fails. Gradients use supported adjacent pixel pairs.
The normalized transform is shared by native and display checks. Original
unaligned metrics are retained alongside aligned acceptance scores.
The fixed shared policy is in `src/scripts/auto_profile_quality.py`; its
rationale and saved physical replay are in
`test-fixtures/qualification/experiments/auto-jpeg-quality-harness/`.
All 16 JPEG-bearing fixtures have committed photographic regression derivatives,
including the four old passing controls, and identity controls. The small
`test_0005` original also clears display limits after radial alignment; its
damaged variant and full-resolution physical fixture still fail. Tests run in CI
without RAWs. Numeric passes still require full-corpus visual review; this does
not establish native detail, host/GPU parity or every-camera quality.
Previewless RAWs separately require exact rendered Auto/Neutral pixel equality;
they remain excluded from JPEG-match pass counts.

Every JPEG-bearing RAW also runs `auto-tail-ramp` with the native AMaZE fit.
Neutral, foliage, blue, magenta and skin ramps must all meet the existing
`test_0000_auto2_*/18_auto_tail/*` ceilings in `banding_budgets.json`.
The runner preserves `photographic_status` separately and fails the combined
case if any ramp fails. Missing producers, wrong demosaic provenance, missing
budgets and inconsistent measurement reports are errors, never skipped passes.
The wrapper builds `maple-cli` with `stage-dump`; supplied binaries need that
feature too. These checks qualify native CPU fits, not host proxy/GPU fits.

The established metric is signed channel bias in five reference-luma bands,
with the unchanged 0.05 limit. Preview extraction normalizes orientation and
Adobe-RGB previews to display sRGB. Geometry uses the established aspect
center-crop and BOX resize followed by structural reference-coordinate alignment;
only the legacy signed-bias metric uses its established inner80% measurement.

```bash
src/scripts/test_color_pipeline.sh
FILTER=test_0000 src/scripts/test_color_pipeline.sh
RAW_DIR=/path/to/raws OUTPUT_DIR=/path/to/new-evidence src/scripts/test_color_pipeline.sh
```

`MAPLE_CLI` pins a renderer. `MANIFEST` may select baseline RAW paths; reference
PNG and ACR-budget entries are not read. Evidence retains PNGs, logs, hashes,
per-band results and `summary.json`. Render/extraction errors, missing RAWs,
empty selections and zero measurable comparisons fail. Preview-less files
are explicitly `no-preview`, never passing matches. CI without RAWs reports
physical accuracy as **NOT TESTED**, while runner contract tests still execute.

Neutral retains AgX's intentional appearance. CPU/GPU parity, synthetic grey,
DCP, exposure, white-balance and clipping invariants remain correctness gates.
No ACR appearance comparison runs in CI or the color gate. The former shell
harness and tone-response checks are manual `diagnose_acr_*.sh` tools only.
Rust/Apple ACR image tests are archived as noncompiled text under
`test-fixtures/qualification/experiments/retired-acr/`; historical references,
budgets and failure ledgers remain evidence, not active Auto requirements.
The old `color_harness` recorder explicitly rejects new qualification writes;
its historical record does not attest to embedded-JPEG accuracy.

### Historical Adobe diagnostics

The retired ACR native-pair protocol, budgets and P3 comparison notes are
preserved in `test-fixtures/qualification/experiments/retired-acr/`.
They do not define Auto's target or a color CI requirement.

---

## Per-domain pipeline gates

| Script                                                                          | Gate?                                         | Inputs                         | In CI                     |
| ------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------ | ------------------------- |
| [`test_synthetic_grey.sh`](../src/scripts/test_synthetic_grey.sh)               | Yes, never skips                              | In-memory DNG                  | `rust-tests`              |
| [`test_synthetic_color_chart.sh`](../src/scripts/test_synthetic_color_chart.sh) | Yes, never skips                              | Synthetic 24-patch chart       | `rust-tests`              |
| [`test_grey_adjustments.sh`](../src/scripts/test_grey_adjustments.sh)           | Yes, never skips                              | In-memory DNG                  | `rust-tests`              |
| [`test_grey_dcp.sh`](../src/scripts/test_grey_dcp.sh)                           | Yes, never skips                              | In-memory DNG                  | `rust-tests`              |
| [`test_banding.sh`](../src/scripts/test_banding.sh)                             | Yes; tail section skips without a RAW         | Synthetic ramps                | `rust-tests`              |
| `test_color_pipeline.sh`                                                        | Fails without measurable RAW/JPEG comparisons | RAWs + embedded JPEGs          | `color-pipeline`          |
| [`test_pano_pipeline.sh`](../src/scripts/test_pano_pipeline.sh)                 | Partly (see below)                            | `raws/pano_*/` sets            | `pano-pipeline`           |
| [`test_film_looks.sh`](../src/scripts/test_film_looks.sh)                       | Yes; skips without the RAW or LUT pack        | `test_0017.dng` + `.mlut` pack | **not in CI**             |
| [`test_face_clustering.sh`](../src/scripts/test_face_clustering.sh)             | Yes                                           | Committed JSONL corpus         | `face-clustering-quality` |
| `test_auto_profile_match.sh`                                                    | Same canonical JPEG gate                      | RAWs + embedded JPEGs          | `color-pipeline`          |
| [`check_wgsl.sh`](../src/scripts/check_wgsl.sh)                                 | Yes                                           | WGSL sources                   | `raw-gpu`                 |
| [`test_halo_detection.sh`](../src/scripts/test_halo_detection.sh)               | Diagnostic only                               | Synthetic disk                 | **not in CI**             |
| [`test_hue_stability.sh`](../src/scripts/test_hue_stability.sh)                 | Diagnostic only                               | Synthetic primaries            | **not in CI**             |
| [`test_stage_diagnostic.sh`](../src/scripts/test_stage_diagnostic.sh)           | Diagnostic only                               | Committed grey DNG             | **not in CI**             |
| [`test_backup_smoke.ts`](../src/scripts/test_backup_smoke.ts)                   | Manual smoke test                             | A running API                  | **not in CI**             |

Notes on the ones with unusual shapes:

- **Banding.** `test_banding.sh` sweeps a neutral ramp plus four constant-hue Oklab chroma ramps, at seven slider extremes, through _two_ stages (the AgX gamut compress and the Rec.2020→sRGB display-encode compress) — either can regress independently. The metric is a second-difference spike, not first-difference monotonicity; `banding_check.py` carries the reasoning. Ceilings live in `banding_budgets.json` and are re-derivable with `BUDGET_INIT=1`. A trailing section fits the shipping Auto Profile tail from a real RAW and gates spike _and_ flat-run (posterization) budgets — that part skips when the RAW is absent.
- **Pano.** Two things always run, fixtures or not: the budgets file must parse with the expected shape, and `pano_metrics.py --self-test` validates the metric implementation procedurally. Set discovery and the per-set gates activate only with `raws/pano_*/` present. Gated keys include `rmse`, `seam_energy`, `wrap_closure_px`, `mean_reproj_px`, and `coverage` — the last is a **floor**, breaching when it falls below its budget.
- **Film looks.** A self-consistency ratchet, not an ACR comparison: each catalog look is rendered and diffed against a committed golden with tight budgets (mean ≤ 0.5, max ≤ 2.0 ΔE₀₀). The fixture uses `--no-bundled-lens`, matching the original goldens' geometry, and both baseline recording and comparison use Pillow Lanczos reduction (#3465). The [refresh qualification](../test-fixtures/qualification/film-3465.json) records old/new hashes, perceptual deltas, luminance-band changes and the passing rerun. A missing golden writes the baseline and fails with "baseline written" — eyeball it, then re-run. It also renders a no-look control and asserts every look differs from it by more than 0.5 mean ΔE₀₀, so a LUT that resolves to a no-op fails loudly instead of passing against its own inert baseline.
- **Web cold-open intent (#4101).** `cd src/web && bun run e2e:cold-profile` is local physical qualification, separate from cloud CI. It requires `test-fixtures/raws/test_0007.DNG` and built GPU/parallel WASM. The four cases exercise CPU and GPU live rendering with As Shot and authored Custom white balance: select Auto while a real Neutral RAW reopen is held, release the actual decode/session reply, then verify the completed render intent, preserved white balance and visible pixels. A missing RAW skips these cases and does not qualify the behavior. Crop posture is covered separately by request-identity and component serializer unit tests.
- **Face clustering.** Runs the pure `clusterEmbeddings` function over the committed JSONL corpus and gates purity / NMI / V-measure / ARI / recall@1 against per-metric floors. No database needed — the CI job doesn't even run `bun install`, because the harness imports only dependency-free modules.

---

## GPU parity

CPU↔GPU agreement is a real gate, and it runs on a **software** Vulkan adapter. The `raw-gpu` job installs `libvulkan1` + `mesa-vulkan-drivers` (lavapipe) on a stock Ubuntu runner, verifies `vulkaninfo --summary` enumerates a device (failing the job outright if it doesn't), then runs the following compile, ABI and parity checks:

```bash
cargo build -p raw-ffi --features gpu                      # the FFI GPU surface compiles
cargo test -p raw-ffi --features gpu --lib gpu_auto_profile::sized::tests # fixture-free sized ABI guards
cargo test -p raw-ffi --features gpu --lib auto_profile_compose -- --test-threads=1 # composition / isolated residual-kernel parity
cargo check -p raw-wasm --all-features --all-targets       # raw-wasm's gpu module tree type-checks
cargo install naga-cli --locked --version 23.0.0
bash src/scripts/check_wgsl.sh                             # naga front-end + validator, no GPU needed
cargo test -p raw-gpu -- --test-threads=1                  # every WGSL kernel vs its raw-core Rust stage
cargo test -p raw-wasm --features gpu                      # render_bytes_gpu vs render_bytes
```

`check_wgsl.sh` exists because naga has no `#include` but the Rust pipeline accessors assemble kernels by prepending generated headers (`generated/color_matrices.wgsl`, `generated/agx_coeffs.wgsl`). It validates each kernel under a ladder of header prefixes — standalone, with matrices, with matrices plus AgX coefficients — and passes if any rung validates, so a kernel calling `mul_rec2020_to_srgb` isn't a false "unknown identifier". naga-cli is pinned to the version wgpu bundles so the gate matches the compiler the app runs.

The job sets `MAPLE_REQUIRE_GPU=1`, which turns raw-wasm's developer-friendly "no adapter, skipping" soft-pass into a panic. On a runner deliberately provisioned with an adapter, a skip is a broken gate, not a valid outcome.

**`raw-gpu`'s tests run serialised in CI (#2336).** The crate's ~200 tests each build their own `GpuContext` from scratch (a fresh wgpu Instance+Adapter+Device), and by default `cargo test` runs them across one thread per logical CPU. On lavapipe that intermittently SIGSEGV'd the whole test binary — always the three `present_chain::tests::offscreen_*` / `present_paints_the_image_not_the_clear_color` tests, the only ones in the crate that create a `wgpu::Texture` and read it back (every other test is buffer-only compute), and always with an identical crash signature and test-binary hash across otherwise-unrelated commits, proving the source diff under test was never the cause. `--test-threads=1` removes the concurrent context churn a software rasterizer isn't validated for, at the cost of wall time, with no test skipped and no coverage lost.

**What this does not cover:** lavapipe is a Vulkan/SPIR-V target, so the gate proves raw-core↔WGSL agreement but says nothing about the Metal backend (naga's MSL output, Apple driver rounding) or a browser's real WebGPU implementation.

**Vectorscope scope pass (#3272)** rides the same `cargo test -p raw-gpu` / `cargo test -p raw-ffi --features gpu` invocations above — no new CI command, three new kinds of coverage: the WGSL kernel against `raw_core::scope::vectorscope_histogram_rgba` on a plain frame and one weighted by a `local_adjustments` mask's alpha-lane write (`raw-gpu/src/scope/tests.rs`); an alpha-passthrough gate proving every RGBA pass in an aggressive multi-stage live chain leaves the lane the scope depends on untouched (`raw-gpu/src/live_chain/tests_scope.rs`); and `LiveSession`'s double-buffered async readback — one tick late, never blocking — cross-checked against a full-precision f32 buffer readback, NOT a dithered u8 reconstruction (`raw-gpu/src/live_session/tests_scope.rs`'s module doc explains why the latter isn't a valid oracle for a chroma histogram). The CPU-fallback path (`maple_apply_chain_and_encode_display_scoped_f32`) has its own closed-form gate in `raw-ffi/src/scene_linear_chain_fused_tests.rs`, since it never dithers and so admits an exact expected total.

### Metal and browser-WebGPU coverage (#2315)

Two additional jobs provide backend-specific evidence. Both currently set **`continue-on-error: true`** in their workflows, so inspect their individual outcomes rather than treating a green workflow summary as proof of execution or parity:

- **`raw-gpu-metal`** (`raw-pipeline.yml`, `macos-latest`) runs `cargo test -p raw-gpu` unmodified, on the real Metal backend a GitHub-hosted macOS runner exposes to headless wgpu. It is deliberately minimal — just the parity tests themselves — because the compile gates and the WGSL naga-frontend validation are backend-independent and already run on Linux. `raw-gpu`'s tests hard-`.expect()` a `GpuContext`, so a missing Metal adapter fails this job outright rather than soft-passing; a clean run is itself the proof the runner has one.
- **`web-webgpu-smoke`** (`web.yml`, `ubuntu-latest`) runs two existing dev-server e2e specs — `e2e/raw-open.spec.ts` (a real RAW decode with no WASM trap) and `e2e/slider-tick-render.perf.spec.ts` (opens a real live GPU/WASM render session and drives the Exposure slider through real per-tick renders) — in headless Chromium with `--enable-unsafe-webgpu` (set by the perf spec's own `launchOptions`, the flag that makes a WebGPU adapter resolve at all in headless Chrome). Both specs already skip-pass without the gitignored `test-fixtures/raws/test_0006.DNG`, the same convention as every other fixture-gated gate, so an unprovisioned run supplies no RAW-open or slider-render evidence — but unlike `color-pipeline`'s fixture probe (which skips before provisioning any toolchain), this job still pays the full Rust/wasm-pack + raw-wasm-build + Chromium-install setup cost every run, the same cost `web-build`/`web-test`/`web-test-common` already pay unconditionally.

The physical upright-canvas regression (`cd src/web && bun x playwright test
--config=playwright.orientation.config.ts`) requires `test_0013.DNG` and a real
Chrome WebGPU adapter. It fails if either is absent. It compares upright canvas,
native dimensions, crop bounds and a radial mask's pixel changes against its
handle, then reopens the real OPFS sidecar through the CPU path.

The physical crop regression (`cd src/web && bun x playwright test
--config=playwright.crop-live.config.ts`) has the same prerequisites and fails
the same way. On the same Rotate90 RAW it applies a rectangle, a quarter-turn,
a free-angle crop and a free-angle crop over perspective to the live WebGPU
canvas, then reopens the OPFS sidecar through the CPU path. The two canvases
must have identical presented dimensions and agree within a coarse spatial
budget, the canvas colour space must survive the resize, and clearing the crop
and perspective must restore the full frame. Pixel-exact placement is gated
natively, not here: `present_texture_tests` compares the GPU present with the
CPU display tail within 1 LSB for every EXIF orientation, including off-axis
crops over perspective.

Real hardware — locally, and through the Apple UITest harness — remains the deeper signal for both surfaces; these two jobs are the cheap, always-on backstop against a divergence reaching `main` with every existing check green.

---

## Apple

```bash
# Prerequisite in any fresh clone: the xcframework's .a files and headers are gitignored.
./src/apple/scripts/build-xcframework.sh          # --debug for fast iteration

# Package unit tests (the substantive Apple test surface).
cd src/apple/Packages/MapleCore && swift test
cd src/apple/Packages/MapleUI   && swift test
cd src/apple/Packages/MapleBackup && swift test

# Xcode targets. The "Maple" scheme carries MapleTests and MapleUITests.
xcodebuild test -project src/apple/Maple.xcodeproj -scheme "Maple" \
  -destination 'platform=macOS' -only-testing:MapleUITests

# iPhone-shell gates run the same way against a simulator.
xcodebuild test -project src/apple/Maple.xcodeproj -scheme "Maple" \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -only-testing:MapleUITests/PhoneExportUITests
```

No fixture-root argument is needed or effective: a trailing `MAPLE_UITEST_FIXTURE_ROOT=…` on the `xcodebuild` line is a _build setting_, not a process environment variable, and never reaches the test runner (#2366). The runner resolves fixtures through `MapleUITests/Helpers/UITestFixtureRoot.swift`: `MAPLE_UITEST_FIXTURE_ROOT` from its own environment — which the scheme's `TestAction` forwards as `TEST_RUNNER_MAPLE_UITEST_FIXTURE_ROOT` (Xcode strips the prefix) — else the repo's `test-fixtures/raws/` located from the bundle's compile-time source path, which is what the iOS Simulator runner uses because the scheme's `$(PROJECT_DIR)` arrives there unexpanded. To point a run at fixtures elsewhere, set the prefixed variable in `xcodebuild`'s own environment:

```bash
TEST_RUNNER_MAPLE_UITEST_FIXTURE_ROOT=/Volumes/Fixtures/raws \
  xcodebuild test -project src/apple/Maple.xcodeproj -scheme "Maple" \
  -destination 'platform=macOS' -only-testing:MapleUITests
```

A fixture missing at the repo default skip-passes (the convention for absent gitignored RAWs); a fixture missing at a root named this way fails the test — an explicit root that doesn't resolve is misconfiguration, not "fixtures not provisioned".

Three local packages hold most of the code: `MapleCore` (roughly 280 test files, covering the pipeline wrapper, sidecar store, sources, auth, and view models), `MapleUI` (the dependency-free design system — its component tests mirror the contracts in `docs/design/maple-ui/components/`), and `MapleBackup`. The Xcode project adds `MapleTests` (view-model unit tests) and `MapleUITests` (live-UI visual harnesses); both are in the shared `Maple` scheme.

The visual harnesses in `src/apple/MapleUITests/` all follow one shape: stage a temp directory with a RAW plus a renamed `.xmp`, launch the app with `MAPLE_UITEST_FIXTURE` set, wait for the `canvas-render-ready` accessibility identifier to flip once the refine pass publishes, screenshot the canvas, and compare numerically.

| Test class             | What it proves                                                                                                                                                                                                         |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MapleUITests`         | One fixture at default settings vs a committed golden (`Goldens/test_0017-default.png`). Budgets: mean ≤ 5, p95 ≤ 10, max ≤ 30, bias ≤ 0.05. Deleting the PNG re-records it and fails with "baseline written"          |
| `SyntheticGreyUITests` | The Apple path (Rust FFI scene-linear → Metal AgX → Metal sRGB encode) lands on the same grey the Rust CPU tail produces: every pixel neutral within ±2 LSB, canvas mean within ±3 LSB of six per-case expected values |
| `CIEDE2000Tests`       | Cross-validates the Swift ΔE₀₀ port against `compare_images.py` on a committed calibration PNG pair                                                                                                                    |

Fixture-dependent classes call `XCTSkip` when the RAW isn't present at the repo default, mirroring the shell harnesses — and fail when it isn't present at an explicitly named `TEST_RUNNER_MAPLE_UITEST_FIXTURE_ROOT`.

### What CI actually builds for Apple

`apple.yml` retains a fast **compile-only** `swift-build` job: `swift build` of the MapleCore package on `macos-15`. It stages a cbindgen-generated `RawPipeline.h` into every xcframework slice and fabricates an empty stub `libraw_ffi.a`, because SwiftPM validates that a binary target's archive exists but never links a static library into a _library_ target. That is enough to catch the recurring failure class — a codegen-added enum case landing beside an exhaustive switch that never gained an arm — without a tens-of-minutes Rust cross-build. `cbindgen` is pinned to 0.29.2 here and in `ci_scripts/ci_post_clone.sh` so generated headers can't drift between the two CIs.

The required `swift-regressions` job also executes a focused MapleCore suite on `macos-latest`, using the newest installed Xcode. MapleUI tests use the same runtime image and Xcode selection; the compile-only gate stays on `macos-15`. It builds only the host `raw-ffi` release archive with `gpu,pano`: panorama is needed to satisfy the package's `maple_pano_stitch` link reference, but the selected tests never run panorama or load ORT models. There are no cross-target builds or iOS ORT downloads. A host-only xcframework, MapleCore/MapleBackup copies and the tiny committed synthetic DNG are staged under `RUNNER_TEMP`; the checkout's framework is untouched. A preprocessed-header symbol check rejects an incomplete archive before linking.

The execution gate runs the classes listed in [`.github/swift-regressions/run.txt`](../.github/swift-regressions/run.txt): the scheduling, cache, geometry, XMP and Metal-safe GPU-state classes from #3363 plus, since #3460, the pure editor-state classes (`EditorStateTests`, `EditorStatePresetsTests`, `EditorCommandRouterTests` and the other `EditorTestCase` subclasses). Every other MapleCore test class is in [`excluded.txt`](../.github/swift-regressions/excluded.txt) with a reason tag (`fixture`, `gpu`, `host`, `slow` or `untriaged`), and the `swift-regressions-coverage` job runs `tools/check-swift-regressions-coverage.py`, which fails when a test class is in neither list, in both, or listed but gone. A new test class therefore has to be placed on purpose; this makes exclusions visible, but does not execute them or prove they pass. In particular, `untriaged` means classification remains unfinished. Inventory totals are not executed-test counts or line/branch coverage. These use generated images, real temporary XMP/cache files, and the committed synthetic RAW; no private/100MP fixtures or UI authentication are required. Tests run serially with Metal enabled. The job fails on test failure, any skip, a missing class, or fewer than 67 executed cases; it does not impose a new hardware timing threshold or allow failures. Started/passed XCTest records and the final suite totals must agree. The uploaded xUnit report is derived from these validated serial XCTest log records (SwiftPM only emits Swift Testing XML in serial mode); the original log is uploaded alongside it.

The remaining package tests, UITest harnesses, and app-target build run locally or on Xcode Cloud. Xcode Cloud's workflows are configured in App Store Connect, not in this repo; the only repository-side hook is [`src/apple/ci_scripts/ci_post_clone.sh`](../src/apple/ci_scripts/ci_post_clone.sh), which installs Rust via Homebrew (with retry/backoff around the worker pool's flaky DNS), adds the four Apple targets, installs the pinned cbindgen, and runs `build-xcframework.sh --release` so the archive has real static libs to link.

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

The required `web-workflow-acceptance` job runs all 24 cases in
`e2e/workflow/white-balance-workflow.spec.ts` against Hosted OPFS and Self Hosted
HTTP/SQLite. It downloads this run's unpatched WASM artifact, runs the canonical
sync script, builds the real native server workflow library, and provisions
Chrome. All RAWs are committed synthetic fixtures; the job requires 24 passed
cases with zero skipped, flaky or unexpected results. Each WB mode verifies
persistence, Undo/Redo, fresh reopen, absolute copy, exact exported pixels,
metadata/foreign XML preservation and unchanged originals. Auto Tone additionally
runs under both Auto and Neutral, checks eight actual RAW recommendations within
generated bounds, preserves unrelated controls/profile, and commits one Undo
entry. Run locally after installing the Web/API dependencies and building WASM
and the native API library:

```bash
cd src/web
bun x playwright test --config playwright.workflow.config.ts white-balance-workflow.spec.ts
```

The same required job separately runs `repeated-workflow.spec.ts` (#4090):
100 successive visible Exposure/Contrast gestures per deployment on one retained
RAW/sidecar. Each cycle persists, checks one Undo boundary, undoes/redoes, loads
through a fresh application root, and compares actual decoded PNG pixels. Exact
foreign XML, caption and original bytes are checked at every persistence stage;
durable history survives its generated bounded compaction. Both 100-cycle JSON
attachments and exactly two passing tests are required, with no retries/skips.
The preceding 24-case report is retained as `wb-auto-tone-results.json` before
the cycle run. This synthetic-RAW adapter qualification does not establish
physical camera color parity, UI accessibility, other action classes or
large-file latency/memory acceptance. Run the cycle gate locally with:

```bash
cd src/web
bun x playwright test --config playwright.workflow.config.ts repeated-workflow.spec.ts
python3 ../../tools/check_web_cycle_evidence.py test-results/workflow/results.json
```

The native `WhiteBalanceWorkflowAcceptanceTests` and
`SMBWhiteBalanceAcceptanceTests` cover the same full Auto Tone action through
Local, the canonical PhotoKit sidecar store and authenticated SMB. PhotoKit
sidecar qualification does not claim a real system PhotoKit-fetch or device UI
test.

Storybook builds (`bun run build-storybook`) exist for the `maple` project but no workflow runs them. Bundle size is gated two ways: Angular's own budgets in `angular.json` (initial bundle warns at 3 MB, errors at 8 MB; any component stylesheet warns at 8 kB, errors at 16 kB) and the tighter hand-written ceilings in the Hosted artifact/capability checks.

---

## API

```bash
cd src/api
bun install
bun test                 # the whole suite, 20s timeout
bun run typecheck        # tsc --noEmit — required CI gate (api.yml)
bun run lint             # oxlint src — this IS a CI gate (cross.yml)
```

Nothing has to be running first. The library database is a file each test makes for itself, so a local `bun test` proves exactly what CI's does. CI runs `bun test --timeout 30000` with a throwaway `MAPLE_JWT_SECRET` and no service containers.

[`src/api/src/db/sqlite/test-sqlite.test-helpers.ts`](../src/api/src/db/sqlite/test-sqlite.test-helpers.ts) gives each test its own database with the schema already applied, and disposes of it when the test's block exits:

```ts
test('rejects a duplicate filename', async () => {
  using handle = await createTestDatabase();
  const db = handle.db;
  // …
});
```

The isolation is per _test_, not per suite, so two tests can insert the same primary key — the unique-index collision between fixtures that #2491 documents — without interfering. `using` disposes the handle even when an assertion throws, and because nothing about the handle is module-level state, tests written this way run correctly under `test.concurrent`; the harness's own [self-test](../src/api/src/db/sqlite/test-sqlite.test-helpers.test.ts) proves that by holding eight databases open simultaneously at a barrier, each with the same asset id in it, and failing loudly if the run turns out to be serialised.

[`src/scripts/test_backup_smoke.ts`](../src/scripts/test_backup_smoke.ts) is a twelve-step manual end-to-end check of the PhotoKit backup endpoints — chunked ingest, sidecar upload, rendered companion, reconciliation feed, deletion notification, then cleanup. It needs a running API, and is not part of any workflow.

---

## Windows

`windows.yml` is the only workflow that builds anything Windows-specific, and it does five things on a `windows-latest` runner: `cargo check` of `raw-core` and `raw-ffi --features gpu` for the MSVC target, `cargo test -p raw-core --lib` (a second architecture for the core's unit tests), `cargo build --release` of the `maple-windows` host crate, `dotnet build` of `Maple.WinUI` for `win-x64`, and `dotnet test` of `Maple.WinUI.Tests`. It then re-runs `tools/codegen.sh` to prove the generator works on Windows too.

The WinUI test project is substantial and mostly logic-level: reducers, math helpers, and file-operation logic extracted from the views so they can be tested without a UI host — including a large `Mui*` set mirroring the shared design system's components.

For shell-state screenshot qualification (#4134), use `--lifecycle-smoke <isolated-RAW> <fresh-output-directory> cpu --shell-visual-checkpoints` with `MAPLE_FORCE_CPU=1` for a 1440×960-DIP client, or `--shell-visual-checkpoints-narrow` for 1024×768 DIPs. The harness scales the requested client size using the actual XAML rasterization scale and applies at most one caption correction using the measured client/window difference; subsequent polling only observes the pending resize. It requires exact physical client pixels and logical content within one physical pixel of the requested size, with stable scale, before every checkpoint. Each `.ready` records requested logical size, actual logical size, client/outer physical size, scale and document state. Capture and inspect all ten named Browse, Preview and Editor states before acknowledging their individual `.continue` files; retain screenshots and accessibility observations alongside the readiness records. The harness checks selection, Info/rail navigation and the bounded centered editor header, then restores the original window and document state. A completed run at one actual display scale does not qualify other DPI settings, Narrator, color parity or the complete feature surface.

For interactive native-window screenshot qualification, invoke the built app directly with `--lifecycle-smoke <isolated-RAW> <fresh-output-directory> gpu --visual-checkpoints`. After measuring each 1440×900 and 1024×768 physical window, the harness writes `visual-<width>x<height>.ready` and holds that size until the operator creates the corresponding `.continue` file. Capture and inspect the real window before acknowledging it. Each checkpoint fails after three minutes without acknowledgement; the regular lifecycle runner remains noninteractive and retains its existing timeout. These checkpoints neither change desktop DPI nor establish screenshot comparison, accessibility, or color parity automatically. Record actual display scale and screenshot evidence separately.

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

| Corpus                                                  | Replayed by                                                                                                                                                             |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test-fixtures/file-operations/cases.json`              | `src/api/src/fs/relocate.parity.test.ts`, `src/apple/…/MapleCoreTests/FileOperations/RelocateParityTests.swift`, `src/windows/Maple.WinUI.Tests/RelocateParityTests.cs` |
| `test-fixtures/file-operations/restore-collisions.json` | `src/api/src/fs/trash-restore-parity.test.ts`, `src/apple/…/MapleCoreTests/FileOperations/RestoreSafetyTests.swift`                                                     |
| `test-fixtures/filename-templates/cases.json`           | `src/raw-pipeline/raw-core/src/filename/tests_fixtures.rs`, `src/apple/…/MapleCoreTests/FilenameTemplateEngineTests.swift`                                              |

Two rules the file-operations corpus states explicitly, and every runner honours: each runner **must** assert the corpus schema version (`schema_version` or `schemaVersion`, as declared) before running a single case (a mismatch is a hard failure, not a warning), and a case whose `requires` capability the platform lacks **must** be skipped with a printed message naming the case and the missing capability. A silently-omitted case is worse than no case at all.

---

## Capability registry and qualification evidence

`docs/capability-registry.md` (human-readable) and `docs/capability-registry.json` (machine-readable) report every editor capability's release state — `core`, `integrated`, or `released` — and are **generated, never edited**: `tools/codegen.sh` emits them, along with the Swift, TypeScript, and C# consumers (`MapleCore/Generated/CapabilityRegistry+Generated.swift`, `maple-common/src/lib/generated/capability-registry.generated.ts`, `Maple.WinUI/Generated/CapabilityRegistry.g.cs`), from two inputs:

- **The registry** — `src/raw-pipeline/raw-core/src/capability_registry/registry.rs`, reviewed Rust. One entry per capability: a permanent snake_case id, an owner, the surfaces it ships on (per [features.md](features.md) § 8), its storage adapters, asset classes, preview and export paths, the `AdjustmentModel` fields it owns (every schema field must be owned by exactly one capability — `capability_registry/tests.rs` enforces it), and the evidence sources it needs for the `integrated` and `released` tiers.
- **Evidence records** — `test-fixtures/qualification/<source>.json`, one per harness run, written by `tools/qualification/record.sh` and committed. Each carries the backend the suite ran on, a blake3 hash of the source's declared corpus, the declared expected case count, and the executed / failed / skipped counts. Records written before #5007 also carry pipeline and sidecar schema versions; those fields are ignored on load and are no longer written. The two sidecar contract corpora additionally hash the sidecar/XMP implementation they exercise, so a reader/writer change stales those records even when no test file moved.

The state rule lives in `capability_registry/evidence.rs` and reads nothing but records. A source is **satisfied** only when nothing in its record failed (failure is conclusive, checked before the corpus so a failed run stays failed on a machine without the fixtures), its corpus hash still matches the files the source declares (`EvidenceSource::corpus`), its backend is one the source accepts, `executed == expected` with both non-zero, and nothing was skipped. No pipeline or schema version gates a record (#5007): a colour change alone never demotes one. A capability is `integrated` when every integration-tier source is satisfied **and every declared surface is covered by at least one of them** (`EvidenceSource::covers`); `released` additionally needs the same of its qualification tier. A capability with no surfaces, or no qualification sources, cannot leave `core` / `integrated` respectively — silence is never evidence, and neither is code presence.

Colour evidence additionally binds the actual manifest to the bytes of every declared RAW, adjustment XMP, optional Adobe authoring XMP and reference PNG, including native/down protocol fields. Its identity also includes the fixed budgets, comparison/harness code and both the on-disk and compiled profile bundle (#4074). Paths locate inputs rather than identify them: byte-identical relocated corpora retain their identity. Repeated RAWs are streamed once, and unreferenced files do not change the measured corpus. Missing or malformed declared inputs prevent recording/loading evidence. The recorder hashes colour inputs before the run and rejects changes detected before writing the final record. The writer hashes the manifest selected by the existing `MANIFEST` override; the registry judges against its current canonical manifest, so a different measured corpus cannot promote current support tiers. Filtered, alternate-budget and noncanonical-resolution diagnostics run directly through the colour harness and cannot stamp the canonical qualification record. Absent gitignored inputs still skip in the rendering harness; they never create a satisfied evidence record.

That rule is what makes the registry demote on its own. Editing `budgets.json`, adding a test to a corpus, or deleting a record all turn the affected sources unsatisfied on the next `tools/codegen.sh` run, and the `codegen-drift` job then refuses to merge until the demoted outputs are committed. Changing pipeline pixels does not: pixel correctness is gated directly by the colour harness and the budgets ratchet, not by recorded evidence. The registry today reports **no capability as `released`**, honestly: no evidence source covers Windows at all, none covers Web at the qualification tier, and the Apple canvas golden (#2366) has no record yet.

Recording evidence:

```bash
# Run a suite and write its record (the suite's own exit code is not the gate — a red
# run records failed_cases > 0, which is exactly what demotes the capabilities using it).
tools/qualification/record.sh grey_adjustments cpu-reference -- bash src/scripts/test_grey_adjustments.sh
tools/qualification/record.sh sidecar_contract_apple xctest-macos -- \
  bash -c 'cd src/apple/Packages/MapleCore && swift test --filter SidecarTransactionContract'
tools/qualification/record.sh gpu_chain_parity_metal metal -- \
  bash -c 'cd src/raw-pipeline && MAPLE_REQUIRE_GPU=1 cargo test -p raw-wasm --features gpu gpu_render'
# Retired ACR color_harness records are historical; run the Auto JPEG gate directly.

# Then regenerate the registry and commit both.
bash tools/codegen.sh
```

The wrapper parses `cargo test`, `bun test`, `swift test`, and the colour harness's own `qualification: executed=… failed=… skipped=…` line, then calls `qualification-record` (`src/raw-pipeline/codegen/src/qualification_record.rs`) to stamp the expected count and corpus hash. Sources, accepted backends, expected counts, and corpora are all declared in `capability_registry/mod.rs`; adding a test to a suite means bumping its `expected_cases` there and re-recording in the same PR.

CI keeps the CI-runnable records honest with `record.sh --check`, which re-runs the suite and fails if its counts differ from the committed record: the four synthetic grey gates in `rust-tests`, the API sidecar contract in `api-tests`, and the lavapipe GPU chain parity in `raw-gpu` (which, having no macOS equivalent, writes the record as a `qualification-gpu_chain_parity_lavapipe` artifact for a human to commit when none exists). The Apple contract suite, Metal parity, and the colour harness are recorded locally, and their records go stale the moment their corpus moves. `codegen-drift` uploads `docs/capability-registry.json` + `.md` as the `capability-release-summary-<sha>` artifact of every run.

### Lens corrections

The Auto JPEG gate renders with default geometry and records its center-crop/resize protocol. Lens geometry has its own independent gates below.

Two gates cover the bundled Lensfun database (#3564). `lens_profile::lensfun::tests_parity` (part of `cargo test -p raw-core --lib`) reproduces `liblensfun`'s own source coordinates and vignetting factors from `test-fixtures/qualification/lensfun-reference.json` at exact sample points, to 0.05 px and 1e-4 in gain; the JSON is regenerated by `src/scripts/lensfun_reference.sh <lensfun-checkout>`, which builds `liblensfun` and runs `src/scripts/lensfun_reference.cpp`. `src/scripts/test_lensfun_vs_lcp.sh` compares the bundled calibration against Adobe's LCP for the same lens on `test_0011.ARW` by diffing the two resolved warp fields (`maple-cli render --lens-warp-out`, `src/scripts/lens_warp_diff.py`) against the ceilings in `test-fixtures/qualification/lensfun-vs-lcp.json`; it skip-passes when the RAW or the Adobe profile is absent, so it is a local gate on the machines that have both.

### Camera and lens support tiers

The same evidence records drive a second generated registry: `docs/camera-support.md` and `docs/camera-support.json`, with the Swift, TypeScript, and C# consumers `MapleCore/Generated/CameraSupport+Generated.swift`, `maple-common/src/lib/generated/camera-support.generated.ts`, and `Maple.WinUI/Generated/CameraSupportRegistry.g.cs`. It answers "how well does Maple support this camera" with five tiers — `qualified`, `profiled`, `matrix-only`, `decode-only`, `unsupported` — plus a **separate** lens axis that never follows from the camera tier.

The four lower tiers are a total function of which branch `color::dcp::profile_for_with_source` takes for a file, so they cannot be hand-set: a bundle hit or a complete embedded profile is `profiled`, an embedded matrix alone is `matrix-only`, the synthetic D65 fallback is `decode-only`, and a file that does not decode is `unsupported`. Promotion to `qualified` needs a physical fixture **and** every qualification suite covering that body satisfied under the rule above — which is why the registry reports **no camera as `qualified`** today: the colour harness has no committed record. Committing one promotes fourteen bodies in the next `tools/codegen.sh` run; letting it go stale demotes them again, in the same `codegen-drift` gate that guards the capability registry.

Apple and Web display the actual file’s tier and explanation beside its camera information, and a separate lens explanation next to lens corrections. The scene-linear FFI buffer and WASM render/session result carry the decoded camera key plus the same profile-resolution branch the core uses to develop it. A file that falls back to a synthetic matrix therefore displays `decode-only`, even if another file from that body is qualified. Unknown or absent boundary metadata makes no support claim. The generated Windows consumer has the same tier ordering, explanations, and per-file promotion rule.

Which physical fixture is which body — its lookup key, the resolver branch it takes, whether it carries lens corrections — is reviewed Rust in `raw-core/src/support_tiers/mod.rs`, and every one of those declarations is checked against a real decode by the fixture-gated `support_tiers::fixture_tests` (skip-passes without `test-fixtures/raws/`). `raw-core/src/color/profiles/COVERAGE.md` remains the human notes on _why_ a body is missing from the bundle; the tier table itself is generated.

---

## Repo tooling gates

These are the twelve `cross.yml` jobs. Fallow checks introduced findings in changed files; it does not certify the existing codebase free of duplication or dead code. UI contract and parity-manifest checks validate declared structure, not runtime interaction or visual parity. The separate `web-build` adoption check covers its declared component scopes, not every control in every application. Everything here runs on every push to `main` and every PR, with no path filter; two are PR-only because they need a merge base to diff against.

| Job                                | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `format-check`                     | `prettier --check` over prettier-eligible files changed vs the merge base (or the pushed range), excluding `test-fixtures/`, `node_modules/`, `dist/`, and the vendored crate sources. Paths are NUL-delimited so asset-catalog names with spaces survive                                                                                                                                                                                                  |
| `oxlint-api`                       | `bunx oxlint src` in `src/api` — correctness rules plus an import guardrail                                                                                                                                                                                                                                                                                                                                                                                |
| `file-budget`                      | `bash tools/check-file-budget.sh` — 400 LOC soft (warn), **600 LOC hard** (fail) over `.rs .swift .ts .tsx .js .py .cs`, minus `tools/budget-allowlist.txt`                                                                                                                                                                                                                                                                                                |
| `budget-headroom` (PR only)        | `bash tools/check-budget-headroom.sh origin/<base>` — fails if the PR **grows** a changed file past 570 LOC. Shrinking is always allowed                                                                                                                                                                                                                                                                                                                   |
| `allowlist-shrinks-only` (PR only) | The LOC allowlist may not gain entries for a file extension it already covers at the merge base (per-extension, not a flat count — #2747). A language newly brought under the gate may seed its own day-0 violators once; split the file instead of allowlisting further growth                                                                                                                                                                            |
| `budgets-ratchet-shrinks-only`     | `check_budget_ratchet.py --self-test` always; the merge-base diff on PRs                                                                                                                                                                                                                                                                                                                                                                                   |
| `codegen-drift`                    | Runs `tools/codegen.sh`, then `git add -N . && git diff --exit-code` so a newly emitted untracked file can't slip past; uploads the capability release summary (#2430) as an artifact                                                                                                                                                                                                                                                                      |
| `maple-ui-contracts`               | `tools/check-maple-ui-contracts.sh` (preceded by its own self-test) — every `docs/design/maple-ui/components/*.md` carries a `**Tier:**` line and non-empty `Purpose`, `Variants`, `States`, `Tokens used`, `Props`, `Accessibility` sections                                                                                                                                                                                                              |
| `editor-parity-manifest`           | `bun tools/check-editor-parity-manifest.ts` (preceded by its own `bun test` self-test) — the editor parity manifest (`src/web/projects/maple-common/src/lib/editor/parity/`) names every web `ToolId` and Apple `Tool` case exactly once, documents every native/web reachability difference with an exception (and carries none for a capability released on both), matches both generated range tables, and agrees with the `docs/features.md` §8 matrix |
| `fallow-audit-web`                 | `fallow audit --base origin/<base>` over `src/web` — dead code, complexity, duplication; fails only on findings the changeset _introduces_                                                                                                                                                                                                                                                                                                                 |
| `fallow-audit-api`                 | Same over `src/api`. `.fallowrc.json` declares the Bun child-process entry points that `Bun.spawn` wires up by dynamic path and static analysis can't see                                                                                                                                                                                                                                                                                                  |
| `gitleaks`                         | Pinned 8.21.2, installed from GitHub releases with double SHA-256 verification, scanning only this PR/push's own commit range so deep history is never re-flagged                                                                                                                                                                                                                                                                                          |

The API Fallow job runs `bun run test:coverage` before `fallow audit --coverage coverage/coverage-final.json` (#3780). A separate preparation process instruments API source with Istanbul and retains original TypeScript function/statement coordinates, excluding tests and declaration files. The test-only preload loads those prepared sources; Babel never changes the test process's global stack formatter. Plain `bun test` runs files in one shared process and global. Its global `afterAll` hook saves cumulative counters after each test file because Bun's test runner does not emit process exit hooks. The producer regression runs two child test files, verifies they share a PID and both calls survive in the final report, checks that unused functions and branches remain zero, and verifies the stack formatter and a real HTTP dependency survive loading. Do not add `--parallel` to this coverage command without collecting and merging worker reports. Coverage output is gitignored.

The measured map covers code executed in the test process. Modules never loaded, and code running only in independent workers or child processes, have no measured entry; Fallow keeps its conservative estimate for unmatched functions. The CRAP ceiling stays at 30. The SSE generator no longer carries a complexity suppression. Reproduce the gate from `src/api`:

```bash
bun run test:coverage
./node_modules/.bin/fallow audit --base origin/main --coverage coverage/coverage-final.json
```

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

# Real EXR/CLI input-integrity regressions (also run in raw-pipeline CI).
python3 -m unittest discover -s src/scripts -p test_diagnostic_evidence.py

# Per-stage RGB trace at one pixel, and raw-value statistics vs the declared white level.
cargo run --release -p raw-core --example stage-trace -- <DNG> <X> <Y>
cargo run --release -p raw-core --example raw-stats   -- <DNG>
```

All of the stage-dump paths need `maple-cli` built with `--features stage-dump`; the scripts handle that themselves and exit non-zero only on a toolchain failure — a build failure, a render failure, or zero EXRs emitted (which usually means the feature flag was missing).

`banding_check.py`, `stage_stats.py`, `stage_diff.py`, and `pano_metrics.py` all carry their own unit tests, and CI runs them in the `rust-tests` and `pano-pipeline` jobs — the measurement tools are gated as carefully as the thing they measure.

### Connected SMB workflow regressions

`SMBWorkflowPublicationTests`, `SMBWorkflowAcceptanceTests` and
`SMBWorkflowRecoveryTests` run against an isolated, authenticated Samba process
on an ephemeral loopback port. Install the server with `brew install samba`.
The Apple regression job installs it and runs these classes without skipping.
They exercise the actual `SMBSource`/AMSMB2 connection, full editor variants,
semantic history, snapshots, restore, Undo/Redo, reopen, rendered export,
original bytes and server-enforced competing publication ownership. A TCP relay
drops one successful rename reply to qualify retry after a lost acknowledgement,
including another client's subsequent save and rejection of a further stale edit.
The same suite rejects stale first semantic and ordinary saves, checks queued
publication ordering and retries an ordinary save with identical accepted XML.
Neither a mounted share nor a
mock sidecar qualifies these tests.

SMB restore is copy-only (#4139/#4173; contract in `docs/features.md`).
`SMBCopyOnlyRestoreTests` runs in the required Swift inventory against the
in-memory transport. It records every delete and rename and fails if restore
consumes a pre-existing path. It also covers a replacement made at the moment the
item is marked, staging-copy failure, and expiry as the only deleter. The physical
counterparts `SMBCopyOnlyRestoreControlTests` and `RestoreCollisionParityTests`
need the gitignored `test-fixtures/raws/test_0017.dng`, so they are excluded from
CI and run locally against the owned Samba server. The backing-replacement control
moves the trashed RAW and XMP aside on the server's own filesystem, puts unrelated
files at those names, and asserts that both the unrelated files and the moved-aside
originals survive byte-for-byte.

The fixture disables Samba's temporary-directory mkdir path using
`vfs mkdir use tmp name = no`: Homebrew Samba on macOS otherwise creates mode
`000` directories and rejects mkdir, reproduced with an independent SMB client.
All directories, credentials and server state belong to the test; system
Sharing and account credentials are untouched. This qualifies real SMB
protocol behavior against the owned server, not any particular user's NAS.

### Actual per-image Auto matching (#4096)

The Profile section reads whether the already-completed render applied a curve or
residual LUT. Pending means no evaluated outcome yet; unavailable covers any
completed fit without usable artifacts, including fit errors. It never infers a
missing embedded JPEG from an unsuccessful fit. Selected Neutral is described
separately. Unavailable does not promise Neutral-equivalent pixels: an extractable
but unusable preview can leave the existing Auto exposure policy in effect even
when neither fit artifact is applied. The UI reports that camera-preview matching
was not applied without changing that rendering policy. Scalar GPU ticks retain the image's outcome without another fit,
source probe, or metadata message; existing render generation guards drop stale
replies.

With physical fixtures provisioned, these explicit gates fail if a fixture is
missing. They check active `test_0007.DNG` and unavailable `test_0018.dng`, preserve
original bytes, and verify that both public render entries return the same frame
for path and byte sources. Both entries share an implementation; this compatibility
check does not independently prove pixel identity against an earlier revision:

```bash
cargo test --manifest-path src/raw-pipeline/Cargo.toml -p raw-core --lib actual_auto_status_ -- --include-ignored --test-threads=1
cargo test --manifest-path src/raw-pipeline/Cargo.toml -p raw-wasm --features gpu --lib actual_gpu_fit_status_physical_4096 -- --include-ignored
cd src/web && bun x playwright test --config=playwright.auto-fit.config.ts
```

The Apple gate requires the active physical `test_0006.DNG`, unavailable
`test_0018.dng`, and committed synthetic RAW. It exercises CPU publication, GPU
fit outcomes, concurrent fit joining, image/profile generation guards, and reopen
without skipping a missing required physical fixture:

```bash
swift test --package-path src/apple/Packages/MapleCore -c release --filter 'testAutoFitStatusRejectsOldImageAndProfileReplies|testActualAutoFitOutcomeWithAndWithoutEmbeddedPreview'
```

The browser gate mounts the shipping Profile section and image canvas with real
OPFS originals, sidecars, and WASM worker. It checks accessible status copy,
selected Neutral, durable reopen, and image changes. It is separate from the
fixture-independent workflow and GPU pixel corpus gates.

The Apple completed-fit scalar-failure test skips when its default
`test_0006.DNG` fixture is absent. As with the existing visual harness, an explicit
`MAPLE_VISUAL_FIXTURE_ROOT` selects the fixture directory and fails if that RAW is
missing. A declared fixture skip is not physical qualification; the provisioned
run must execute the real decode, eviction, and missing-source failure checks.
