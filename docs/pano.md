# Panorama stitching

Maple stitches panoramas from RAW frames with `maple-pano`, a crate in the Rust workspace that owns the whole job: decode the frames into scene-linear pixels, find and match features with two ONNX neural networks, verify each pair geometrically, solve every camera's orientation at once, then warp, exposure-match, seam and blend the result into one canvas. The output is a scene-linear Rec.2020 composite, written as a 16-bit PNG. It has two alignment strategies — **rotation** for a camera that pivoted in place, **tile** for a camera that translated (nadir mapping strips, film scans, flatbed art) — and by default it decides between them from the image content rather than from metadata. One shared orchestration function serves both callers, the `maple-cli pano stitch` command and the `maple_pano_stitch` C-FFI entry the Apple apps use, so the CLI and the app cannot drift apart.

The dependency that makes it awkward to ship is ONNX Runtime, which the feature detector and matcher run on. It is not committed to the repo and not bundled: macOS dlopens a dylib the user provisions, iOS statically links an official ONNX Runtime xcframework at build time, and the self-hosted server shells out to a `maple-cli` binary whose path an operator configures in Settings. Every surface therefore has a "not provisioned yet" state, and every downloaded artifact is SHA-256 pinned.

## The pipeline

`src/raw-pipeline/maple-pano/src/stitch/mod.rs` is the single orchestration. Its stage ordinals are part of the C ABI's progress contract:

| Stage | What happens                                                                           | Modules                                            |
| ----- | -------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 0     | Decode each frame once, derive priors, keep only a downscaled proxy                    | `ingest/`                                          |
| 1     | Load the ONNX models, extract features from every proxy                                | `models`, `features/`                              |
| 2     | Nominate candidate pairs, verify each, build the match graph; then select the strategy | `graph`, `robust`, `twoview`, `strategy`           |
| 3     | Re-localize verified matches at full resolution, re-verify                             | `refine/`                                          |
| 4     | Bundle adjustment over all cameras, then level the horizon                             | `ba/`, `leveling`, `local_align/`                  |
| 5     | Canvas → gain → warp → seam → blend                                                    | `canvas/`, `gain/`, `warp/`, `composite/`, `blend` |

Both strategies share stages 0–2 — the decode, the ML pass, and the match graph — and diverge only in the tail, so choosing tile costs no second decode and no second ML run.

### Ingest and priors

`raw_core::decode_for_pano` (`src/raw-pipeline/raw-core/src/pipeline/pano/mod.rs`) is the single pixel source. Both it and `read_pano_metadata` are panic boundaries: rawler rejects some inconsistent on-file metadata with a bare `assert!` rather than an error, and the ingest runs on user-selected assets inside the Self Hosted job-runner's `maple-cli pano stitch` subprocess, so a caught panic surfaces as `raw_core::Error::DecodePanicked` → `PanoError::RawDecode` — a failed frame, never a dead process (#3230). It runs the canonical develop chain truncated **before every display-prep stage** — no auto-exposure, no capture sharpening, no view transform — so descriptors and exposure solving see unbiased pixels. `ingest/` turns that into planar f32 R/G/B in scene-linear Rec.2020 D65, plus a 1-bit-per-pixel validity mask. Validity is born at decode: the DNG DefaultCrop drops the optical-black border and demosaic margin, so every surviving pixel starts valid and later stages only ever _remove_ validity (warp marks out-of-frame, and so on).

`ingest/priors.rs` reads the EXIF focal length (converted to pixels) and, on DJI frames, the gimbal yaw/pitch/roll from the `drone-dji` XMP namespace — parsed namespace-aware, because two different namespace URI variants are in the wild. Priors are advisory throughout: they seed initialization and nominate candidate pairs, never decide anything.

`ingest/proxy.rs` produces the long-edge-capped proxy features run on. The default cap is **1600 px** and that number is measured, not chosen: 1280 (ALIKED's native input size) starved the matcher on the acceptance set, where `pano_01` regressed to the tile strategy with 19 orphans, versus rotation with zero frames dropped and mean residual 1.13 px at 1600. The proxy feeds only the match and solve phases, not the composite, so the larger cap costs essentially no memory.

### Features and matching (ONNX)

`features/aliked.rs` runs **ALIKED-N16rot** (detector plus 128-D descriptor, top-2000 keypoints baked into the graph). `matching/lightglue.rs` runs **LightGlue** paired to those descriptors, returning index pairs and confidences. `glue.rs` adapts the matcher's records into the geometry side's `PixelCorrespondence` input.

`models.toml` in the crate root is the manifest: filename, SHA-256, byte size, source URL, and license for each model. The ONNX files are **not committed**. `models::ModelDir::resolve` reads them from the directory named by `MAPLE_PANO_MODELS` (or an explicit path) and verifies size and digest before any session is created — a mismatch is a hard error, never a fallback. The manifest also records why the shipped detector is `n16rot` rather than the spec's `t16`: no public ALIKED-t16 ONNX export exists, and swapping one in later is a manifest re-pin, since the Rust side reads keypoint count and descriptor width from the tensor shapes at runtime.

ONNX Runtime itself is loaded two ways, which is why `maple-pano` has two Cargo features over the same `ort` dependency:

| Feature     | Target             | ORT linkage                                                                                                                                                |
| ----------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ml`        | macOS / host       | `ort/load-dynamic` — dylib dlopen'd from `ORT_DYLIB_PATH`, with a `libloading` preflight probe so a missing dylib becomes a typed error instead of a panic |
| `ml-static` | iOS, iOS simulator | statically linked against the official ONNX Runtime iOS xcframework via `ORT_LIB_LOCATION`                                                                 |

Static linking on iOS is not a preference — the iOS sandbox blocks `dlopen` of arbitrary paths.

### Match graph and pair verification

`graph.rs` builds "a graph, not a chain." Candidate pairs come from pluggable providers: `CaptureOrderProvider` (consecutive frames in input order) and `GimbalPriorProvider` (pairs whose prior view directions are closer than 1.5× the per-image field of view). Each candidate is verified by `robust::verify_pair`, a MAGSAC-style robust estimator over the closed-form relative rotation in `twoview.rs` (bearings plus a Wahba solve, backed by the Jacobi eigensolver in `eigen.rs`), and becomes a verified edge only with enough inlier support. The builder reports connected components and orphans, because the rule is to stitch the largest component and report the orphans — never silently drop a frame or force-align it.

### Full-resolution refinement

Matching happens on proxies, so match accuracy is bounded at proxy scale — the matcher's roughly half-a-proxy-pixel floor is about 3× the full-resolution residual budget at a 1600 px cap on a 5300 px frame. `refine/` closes that gap: every verified correspondence is re-localized on the full-resolution frames with a zero-normalized cross-correlation template search and a 3-point parabolic sub-pixel peak fit, so bundle adjustment consumes full-resolution accuracy in full-resolution coordinates and the residual budgets mean what the spec intended. Correspondences that fail to refine are counted separately (`fallback_matches`) rather than dropped.

### Bundle adjustment, leveling, local alignment

`ba/` refines all camera rotations plus shared intrinsics (focal, `k1`, `k2`) by minimizing symmetric reprojection error over every verified inlier, with a Huber loss at δ = 2 px. It is Levenberg–Marquardt with analytic Jacobians, rayon-parallel residual evaluation, and an in-tree dense Cholesky — no external solver, consistent with the crate's hand-rolled `math`/`eigen` and zero-dependency policy; even at 150 cameras the state is only about 500 parameters. A pure-rotation cost is invariant under a global rotation, so the gauge is fixed by freezing the first frame of the active component. Each solve runs two stages: rotations only with intrinsics frozen, then a joint solve — otherwise wildly wrong early residuals push focal and distortion off before the rotations settle.

`leveling.rs` then applies one global rotation to level the horizon: under a leveled sweep every camera's x-axis lies in the horizontal plane, so the up direction is the least-eigenvalue eigenvector of the scatter of solved x-axes. This is the fix for the "banana" bend in long strips.

`local_align/` (Stage F) absorbs what a pure rotation model structurally cannot: centimetre-level camera position drift. The correction is a strongly regularized per-frame **bilinear mesh**, and the module documents why it is not an affine — an affine delta reduced dropped frames' mean residuals by only ~12% on the 21-frame DJI set and never moved their maxima under budget, because parallax displacement depends on scene depth, which varies across the frame. A bilinear mesh is the coarsest model that can represent that; it subsumes the affine exactly.

### Compositing

`composite/` orchestrates canvas → gain → warp → seam → blend.

`canvas/auto.rs` picks the projection from the camera set's angular extent — under 60° rectilinear, 60–130° cylindrical, over 130° spherical — and sizes the canvas to preserve the maximum input angular pixel density, under a total-pixel cap (default 256 megapixels).

`gain/` solves exposure compensation as least squares over mean intensities in pairwise overlap regions (Brown & Lowe), in _linear_ scene light, where exposure genuinely is a single multiplier. A per-frame anchor term keeps frames with no overlap solvable — they come out at exactly 1.0. `gain/streaming.rs` is the memory-bounded variant that decodes each frame once and accumulates pair statistics incrementally.

`warp/` is a validity-aware inverse map: canvas pixel → world direction → camera forward projection (rotation, intrinsics, distortion) → bicubic Catmull-Rom tap on the source, with validity-weighted renormalized kernel taps so frame edges and masked holes never smear into the output. The per-frame gain multiplier is folded into the sampling loop.

Seam placement is one of two strategies (`seam::SeamStrategy`, #1179), chosen per run and recorded on `CompositeReport`/the CLI's `StitchReport`:

- **Voronoi** (default) is by source-border distance: each covered canvas pixel belongs to the frame whose projection of it sits deepest inside that frame. Deterministic and content-blind.
- **Graph-cut** (`--seam-strategy graph-cut`) is content-aware: `seam::pairwise::cut` builds a Boykov–Kolmogorov max-flow/min-cut (`seam::bk`, ported from the closed PR #17 prototype) over a pair of overlapping frames, with a data term that's the gradient of the two frames' _difference_ image (near-zero on a well-aligned region even under a residual exposure mismatch, spiking wherever content is misaligned or moving) and a smoothness term that discounts cost in areas of high local contrast (a handoff there blends into existing detail; the same handoff in a flat sky or wall is what a viewer's eye catches). `seam::labels` resolves the N-frame case by repeatedly applying that pairwise cut as an alpha-expansion move over every overlapping pair until the labelling converges, then feathers the result by one blend-band width. Because content-aware seam finding needs overlapping frames' actual pixels together — something the tiled path's "one frame resident at a time" streaming can't provide — `seam::masks` runs the whole label solve once on a cheap downsampled "seam canvas" (capped at 1 MP total, so any one pairwise overlap stays well under the spec's ~2 MP) and hands the tiled composite a bilinear lookup ([`SeamMasks::weight`]) instead of full-canvas-sized masks, keeping the #1254 memory bound intact. `seam::pairwise` also caps `BkGraph::solve`'s augmenting-path iterations (`MAX_ITER`, fixed, not scaled by node count) — the vendored BK solver's own documented heterogeneous-capacity pathology (see `seam::bk`'s module doc) turned out to bite hard on real photo texture: an initial `COST_SCALE` of `1e6` produced a real pano_01 overlap that took multiple minutes to solve, fixed by dropping the scale to `1e3` and adding the cap (`seam::pairwise::tests::perf_probe_realistic_textured_overlap` guards the regression). Voronoi stays the default: every `pano-budgets.json` ratchet is measured against it, and graph-cut is opt-in until a follow-up re-baselines those budgets with it as the default.

`blend.rs` is Burt–Adelson multi-band Laplacian blending with the separable `[1,4,6,4,1]` binomial kernel, validity-weighted at every pyramid level so masked regions never bleed value in; band count is `log2(minimum overlap width)`, capped.

Compositing always runs the **tiled** path on the rotation strategy. `composite_tiled` takes already-solved gains and a strip height, decodes each source frame on demand one at a time, warps it into a `canvas_width × tile_rows` strip, and frees the pixels before the next frame. Under the default Voronoi strategy the ownership mask needs only camera geometry, no pixels; under graph-cut each strip is instead accumulated as a weighted blend sampled from the precomputed seam masks. Without the tiled path, all N full-resolution frames would be resident at once.

Finally `stitch/io.rs`'s `develop_for_display` runs the same view tail raw-core uses for a RAW — **AgX** at neutral contrast, then Rec.2020 → sRGB primaries, then the sRGB transfer curve, then 16-bit quantization. A stitched pano has no embedded camera JPEG, so there is no Auto Profile to fit and AgX/Neutral is the correct fallback. This matters: written raw, the scene-linear Rec.2020 composite re-opened cold looking desaturated and flat, because a non-RAW file is assumed to be display-encoded sRGB and the data was then misread on every axis at once. `exif_embed.rs` builds a small TIFF blob for the PNG `eXIf` chunk carrying Make/Model/Software, exposure fields, and GPS when the source frames had it, so Apple's ImageIO surfaces the pano's camera and location panel.

## Tile strategy and exposure matching

`tile/` is the planar branch, selected when the match graph's edges are better explained by 2D similarity transforms than by camera rotations. Each verified edge gets a similarity fit from its inlier correspondences (`similarity/`, refined with the full-resolution matches), the pairwise offsets are turned into absolute canvas poses by a global anchored least-squares solve with frame 0 as the identity anchor, and then the geometry-agnostic downstream stages — gain, Voronoi seam, multi-band blend — run unchanged.

Exposure matching on this branch is more elaborate than the rotation branch's scalar gains, in two layers solved in the log domain from one strided canvas scan (`tile/photometry.rs`, `tile/exposure_field.rs`, `tile/sampling.rs`):

- **Layer A — gains plus a shared ramp.** Each frame's recorded value is modelled as a per-frame log-gain _plus one within-frame linear slope shared by every frame_ — same camera, same sun, so a low-sun BRDF hotspot or decentered falloff is fixed in frame coordinates. Solving the slope jointly is what prevents the scalar-only failure mode: with scalars alone, a constant within-frame slope makes every consecutive overlap read "the next frame is dimmer," and least squares integrates that bias along the chain into an enormous cross-strip ramp — measured at 19× (4.2 EV) on a strip whose frames were actually equally bright. The slope is identifiable because pairs exist at several baselines: gain differences must agree across baselines, while slope terms scale with the frame-local offset.
- **Layer B — residual exposure fields.** What the gain-plus-ramp model cannot express (cloud shadows, genuine light changes, non-linear falloff) is aggregated as per-pair log residuals on a coarse canvas grid (canvas/128 per side) and solved as one smooth per-frame correction field — a screened-Poisson system with a data term tying overlapping frames, a gradient smoothness penalty, and a weak gauge anchor, solved matrix-free by conjugate gradients. Fields are bilinearly upsampled at composite time, so memory stays at the coarse grid.

Both corrections are applied per pixel during the warp.

### Auto strategy selection

`strategy.rs`. For every verified edge the selector runs the similarity estimator on the same inlier matches rotation verification produced, and records the rotation-model inlier RMS (angular residual converted to pixels at the frame's focal length) against the similarity-model inlier RMS. A pair votes "tile" when the planar residual is enough better; the majority decides, and a tie or bare majority selects rotation — deliberately conservative, because misclassifying a pure-rotation set as tile is the worse error. Gimbal metadata, when every frame shares an attitude, is recorded as `gimbal_corroboration` in the evidence block; it never decides and never overrides the content vote. When auto picks tile on what looks like an intended pano capture, the report carries the warning "Sideways motion detected; pivot in place for best results." An explicit `--strategy tile` is operator intent and gets no warning.

## Memory

A 21-frame 100 MP DJI set is the working reference, and peak resident memory is the design constraint throughout.

| Phase              | Bound                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------- |
| Stage 0 decode     | full-resolution buffer freed immediately; only proxy planes and metadata stay resident |
| Stage 3 refinement | 2-entry LRU decode cache — at most 2 full-resolution frames at once                    |
| Gain solve         | frames decoded one at a time, freed before the next                                    |
| Stage 5 composite  | tiled strips, one decoded frame per strip pass; default 512 canvas rows                |

Measured on the 21-frame set, frame-processing peak dropped from about 34 GB to about 4.9 GB. End-to-end peak is around 13.6 GB, dominated by ONNX Runtime's own roughly 8.7 GiB resident floor.

## The C-FFI surface

`src/raw-pipeline/raw-ffi/src/pano.rs` defines the ABI; `pano_apple.rs` is the platform-agnostic body that calls `maple_pano::stitch::stitch`. Two Cargo features select the ORT linkage: `pano` (macOS, `maple-pano/ml`) and `pano-ios` (iOS and simulator, `maple-pano/ml-static`).

```c
int32_t maple_pano_stitch(
    const char *const *raw_paths, size_t count, const char *out_png_path,
    MaplePanoRetention retention,       // KEEP = 0, STRICT = 1
    MaplePanoLocalAlign local_align,    // MESH = 0, OFF = 1
    MaplePanoStrategy strategy,         // AUTO = 0, ROTATION = 1, TILE = 2
    MaplePanoProgressFn progress_cb, void *cb_user,
    const MapleCancelFlag *cancel);
```

`0` is success, negatives are hard errors, positives are soft errors, and `maple_last_error()` carries the human-readable reason.

| Code | Meaning                                                 |
| ---- | ------------------------------------------------------- |
| −1   | null pointer in a required argument                     |
| −2   | fewer than 2 input frames                               |
| −3   | unsupported platform (Linux, WASM)                      |
| −4   | a `raw_paths` element is null or not UTF-8              |
| −5   | `out_png_path` is not UTF-8                             |
| −6   | ML environment unavailable (models or ORT missing)      |
| −7   | pipeline error — decode, match, BA, composite, or write |
| −8   | degenerate rotation geometry; retry with Auto or Tile   |

The progress callback is `void(*)(uint32_t stage, float frac, void *user)`, invoked from worker threads — the host must not block it. Both the callback and the cancel flag accept null. The function joins all worker threads before returning, so caller pointers only need to live for the synchronous call.

`pano_ffi_gates` (`src/raw-pipeline/raw-ffi/tests/pano_ffi_gates.rs`) is the end-to-end parity gate: it calls the actual C entry point, paths in and PNG out, and diffs the result against the reference by peak-normalized RMSE, tolerating up to 2% dimension difference from canvas rounding. It skip-passes when fixtures, `MAPLE_PANO_MODELS`, or `ORT_DYLIB_PATH` are absent.

## Apple

`src/apple/Packages/MapleCore/Sources/MapleCore/Panorama/`.

`PanoStitching.swift` is the protocol seam plus the option types (`Retention`, `LocalAlign`, `Strategy`) and the `PanoStage` enum whose raw values match the CLI's stage log prefixes. `MockPanoStitcher` satisfies it for previews and tests. `RustPanoStitcher.swift` is the real conformance over `maple_pano_stitch`, running off the main actor because the call blocks for minutes.

Progress bridging is the interesting part. The C trampoline can fire from several rayon worker threads at once, so its hot path does exactly one thing: reconstruct a heap-allocated atom from the opaque `cb_user` pointer, take an `os_unfair_lock` for a two-word store, release. No task allocation, no main-actor hop. A timer polls that atom about 20× a second on the main run loop and publishes only when the value changed. Lifetime is a retain before the call and an unconditional release after, safe because the FFI joins its workers before returning. `cancel()` flips a Rust-allocated cancel flag, the same pattern the scene-linear render path uses.

`PanoMergeSession.swift` is the `@Observable` state machine (idle → running → done | error) with generation-counter discipline so a cancel-then-rerun can never publish stale progress.

The two Apple slices differ in one solver setting. iOS requests the **CoreML execution provider** for both ONNX sessions, so eligible operations route to Apple silicon and unsupported ones fall back to ORT's CPU provider automatically. macOS deliberately does not: that path is parity-verified against the references and stays on CPU ORT.

Provisioning is three files. `PanoProvisioning.swift` resolves the two ML paths in priority order — UserDefaults set from Settings → Pano, then `MAPLE_PANO_MODELS` / `ORT_DYLIB_PATH` environment variables, then the default Application Support locations — and reports a status the settings UI renders. `PanoProvisionManifest.swift` pins each downloadable artifact by URL, SHA-256, and byte size, kept in sync with the Rust `models.toml` (a drift shows up as a hard error at stitch time, since the Rust loader re-verifies). `PanoProvisioner.swift` downloads and installs them: every artifact is digest- and size-verified, a mismatch deletes the partial download and fails hard, an already-verified artifact is skipped, and it installs only to the app-support default — if a higher-priority override is set, auto-download would not change what the resolver picks, so it isn't offered. iOS downloads the models only; its ONNX Runtime is the static framework embedded at build time.

### Build note

`src/apple/scripts/build-xcframework.sh` defaults to a **release** build, and the script's own header explains why in pano terms: `maple_pano_stitch` runs roughly 16× slower in debug on this CPU-heavy SIMD/ONNX workload — a measured 5785 s debug versus 353 s release for the same 21-frame stitch on an M4. `--debug` prints a warning and is only for fast-recompile iteration where pano performance is irrelevant. The script builds macOS slices with `--features gpu,pano` and iOS/simulator slices with `--features gpu,pano-ios`, and provisions the ONNX Runtime iOS static xcframework into `~/.cache/maple-pano/ort-ios/` first.

## Server (self-hosted)

Stitching on the server is a **job**, not a pipeline stage — it is a one-off, user-selected action on a specific set of photos, not an "eventually every asset gets this" backlog.

`src/api/src/job-runner/handlers/pano-stitch.ts` resolves the selected assets to absolute paths, spawns `maple-cli pano stitch … --out <output.png> --retention … --local-align … [--strategy …]`, parses stderr lines prefixed `pano:` for coarse six-stage progress, and on success upserts the output PNG into the library as a new asset.

`src/api/src/routes/pano.ts`:

| Route                       | Behaviour                                                                                                                                                   |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/pano/stitch`     | Creates the job. Returns 409 `pano_not_provisioned` when disabled or unconfigured, and 409 `pano_job_running` when a pano job is already queued or running. |
| `GET /api/pano/jobs/:id`    | Job status.                                                                                                                                                 |
| `DELETE /api/pano/jobs/:id` | Request cancel.                                                                                                                                             |
| `GET /api/pano/config`      | Effective config plus a probe of whether the configured binary supports `--strategy`.                                                                       |
| `PUT /api/pano/config`      | Upsert settings and re-probe.                                                                                                                               |

The single-concurrency rule checks both `queued` and `running`, not just running: close-together requests could otherwise enqueue several jobs that workers later execute concurrently, and a pano run is tens of gigabytes of resident memory, so concurrent runs take the box out.

`src/api/src/pano/pano-config.repo.ts` stores the settings as one document in `app_settings` — `maple_cli_path`, `models_dir`, `ort_dylib_path`, `enabled` (default `false`). `maple_cli_path` and `enabled` are DB-only; `models_dir` and `ort_dylib_path` fall back to the process environment when unset, which is documented in the UI, so an operator can bootstrap from a `.env` or Docker Compose file before reaching the settings page. Path inputs are validated absolute and rejected if they start with `-`, so a configured value cannot smuggle a flag into the spawned command line.

The web surfaces are `PanoService` (`src/web/projects/maple-common/src/lib/api/pano.service.ts`), the merge dialog (`maple-common/src/lib/pano/pano-dialog.component.ts` and the `mui-panorama-merge-modal` component), and the owner-gated settings page at `/settings/pano` (`src/web/projects/maple/src/app/settings/pano/`). The stitch request references assets by absolute server-side path where possible — the server resolves each to an asset document, indexing on demand — and by Mongo id for cloud-hosted assets with no local path.

## Fixtures, harness, and gates

Fixture sets live at `test-fixtures/raws/pano_<NN>/` (gitignored, ≥ 2 `.dng` frames each) with references at `test-fixtures/references/<set>/<set>.png`. The tracked ratchet is `test-fixtures/pano-budgets.json`.

```bash
# Full harness (skip-passes without fixtures)
src/scripts/test_pano_pipeline.sh
FILTER=pano_01 src/scripts/test_pano_pipeline.sh

# One set, by hand
cd src/raw-pipeline
cargo build --release --bin maple-cli --features pano
MAPLE_PANO_MODELS=~/.cache/maple-pano/models \
ORT_DYLIB_PATH=/path/to/libonnxruntime.dylib \
  ./target/release/maple-cli pano stitch <frames…> \
    --out pano.png --display pano-srgb.png --report pano.json \
    --strategy auto --retention keep --local-align mesh
```

`test_pano_pipeline.sh` runs two things unconditionally, fixtures or not: it validates that `pano-budgets.json` parses and has the expected shape, and it runs `pano_metrics.py --self-test` (an identical pair scores near zero, a perturbed pair clearly non-zero, and a wrap-shift is recovered). With fixtures present it discovers the sets, writes an effective manifest, invokes `maple-cli pano stitch --manifest … --out-dir …`, and gates each set. It builds `maple-cli` with `--features pano` itself if no binary is present, or honours `MAPLE_CLI`.

`src/scripts/pano_metrics.py` is the one pano diff implementation — numpy and Pillow only. Gateable keys per set:

| Key                                                                     | Meaning                                                                                                                                                                      |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rmse`                                                                  | size-normalized RMSE against the reference (both sides downscaled to a 2048 px long edge first)                                                                              |
| `coverage`                                                              | a **floor**, not a ceiling — the fraction of reference content the candidate covers, which prices the holes left by dropped frames; it breaches when it falls _below_ budget |
| `seam_energy`                                                           | seam-line gradient energy                                                                                                                                                    |
| `wrap_closure_px`                                                       | 360° wrap-edge closure error in native pixels, for full-circle sets                                                                                                          |
| `mean_reproj_px`, `max_reproj_px`, `horizon_tilt_deg`, `dropped_frames` | passthrough from the stitch report JSON                                                                                                                                      |

Only keys present in an entry gate. A set with no budget entry **fails** with `no-budget-entry` and prints its observed numbers, so the fix is: run once, read the numbers, set ceilings 5–10% above them, and commit the entry with the change. Budgets are a one-way ratchet — ceilings only go down and the coverage floor only goes up, in the same commit that delivers the improvement.

Crate-level gates:

```bash
cd src/raw-pipeline
cargo test -p maple-pano                    # geometry unit tests (no ML modules, no testkit gates)
cargo test -p maple-pano --features ml      # + the ALIKED/LightGlue stitch pipeline (skip-passes without models)
cargo test -p maple-pano --all-features     # + the testkit-gated solver gates — what CI runs
```

The `testkit` feature generates synthetic correspondences with exactly known camera parameters, which is what makes the two-view, graph, BA, refine, motion, local-alignment, and composite gate suites real geometry rather than regression snapshots. `tests/ml_smoke.rs` (`--features ml`) runs ALIKED and LightGlue on a synthetic overlapping pair rendered by the crate's own ground-truth renderer and reprojects every match through the known rotations; it skip-passes with an explicit message when models or the ORT dylib are absent, and fails loudly on anything else — digest mismatch, interface drift, geometric garbage.

CI (`.github/workflows/raw-pipeline.yml`) runs a `--features pano` compile gate on `maple-cli` and the `pano-pipeline` job, which executes the harness. Without the gitignored corpus the candidate gates are a no-op and only the metrics self-test runs, so CI stays green without fixtures.

Two diagnostic binaries ship with the crate: `pano-ingest-probe` decodes real frames through `decode_for_pano` and prints per-channel statistics plus the EXIF/gimbal priors table, and `pano-gt-render` renders synthetic frame sets from exactly known cameras.

## Geometric conventions

These are binding across the crate (`src/raw-pipeline/maple-pano/src/lib.rs`), and worth knowing before touching any geometry module.

- **World frame:** right-handed, +X east, +Y down (nadir), +Z forward; "up" is −Y. Cameras share the world origin — pure rotation, no translation.
- **Camera frame:** +X right, +Y down, +Z along the optical axis.
- **Rotation:** stored as a Rodrigues axis-angle vector of the _camera-to-world_ rotation. Positive yaw turns the view east; positive pitch tilts it up.
- **Pixels:** continuous coordinates with the origin at the top-left corner; texel `(ix, iy)` covers `[ix, ix+1) × [iy, iy+1)` with its centre at `(ix + 0.5, iy + 0.5)`. The principal point is fixed at the image centre.
- **Equirect:** `u = (λ/2π + 0.5)·W`, `v = (0.5 − φ/π)·H`; row 0 is the zenith, horizontal wrap, vertical clamp.
- **Distortion:** radial polynomial `r_d = r·(1 + k1·r² + k2·r⁴)`, inverted by Newton iteration.
- **Light:** everything is scene-linear. PNG inputs are normalized without a transfer decode; outputs are 16-bit.

Determinism is a property the crate maintains deliberately: the PRNG is pinned in-tree (SplitMix64), blending is sequential row-major per plane, the exposure-field solver iterates ordered maps, and warp rows are rayon-parallel over pure per-pixel work. Identical inputs produce identical bytes on a given platform and toolchain.

See [pipeline](pipeline.md) for the develop chain ingest truncates, [apple](apple.md) for the app targets and xcframework build, [api](api.md) for the job runner, and [testing](testing.md) for the full gate list.
