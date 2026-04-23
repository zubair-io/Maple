# 09 — Open Questions

Unresolved behaviors, suspected dead code, deferred decisions, and places where the current implementation is a known approximation. Everything here is **not a bug report** — it's a list of things a rewrite should decide on explicitly rather than inherit by default.

Each item: the question, what Maple currently does, why it's unresolved, and a recommendation for the rewrite.

---

## Pipeline and algorithms

### 9.1 Scene-referred vs display-referred interactive working space — RESOLVED

**Decision.** Linear Rec.2020 D65, scene-referred, f32 throughout. The view transform (AgX) is a distinct pipeline stage immediately before display encode.

**Where it lives.** [`04-color-management.md`](./04-color-management.md) (the full rewrite around scene-referred) and [`02-pipeline.md`](./02-pipeline.md) § "Three-band filter chain".

**Why this and not the earlier recommendation.** The earlier recommendation ("keep Display P3 in v1 for feel-parity with Lightroom") assumed the cost of rebuilding slider feel outweighed the headroom benefit. Re-examining the roadmap (tone-mapping redesign was already on the v2 path) and surveying state-of-the-art view transforms (AgX in Blender 4.x, ACES 2.0, OpenDRT) made it cheaper to do the scene-referred redesign _now_ than to carry a display-referred v1 into a scene-referred v2. The one-person-week slider recalibration pass is absorbed into the v1 schedule, not deferred.

**Cascading decisions that fell out of this one:** f32 working texture (9.16), AgX as the view transform (new 9.44), gamut mapping via AgX (9.15), per-channel Clarity in scene-linear vs Oklab-L (9.6).

---

### 9.2 Parametric tone curve vs sequential sliders — RESOLVED (re-derived)

**Decision.** Sequential scene-linear operations, with Contrast relocated to the AgX sigmoid slope. Not the parametric PV11 form.

**Where it lives.** [`03-algorithms.md`](./03-algorithms.md) § 3.6 `SceneToneControls` and § 3.6a `AgXViewTransform`.

**Why.** The original question assumed a display-referred tone group where Contrast, Highlights, Shadows, Whites, and Blacks all compete for the same ~0–1 range. In the scene-referred rewrite:

- Exposure, Highlights, Shadows, Whites, Blacks remain sequential **scene-linear** operations with soft knees where appropriate (values can and do exceed 1.0 before AgX sees them).
- Contrast is **not** applied in scene-linear; it modulates the AgX sigmoid slope (`effective_slope = base_slope + contrast/200 * 0.5`). That is where perceptual contrast lives in a scene-referred pipeline.
- The per-channel tone curve stays scene-linear with `ref_max = 4.0` so it can reach into highlight headroom.

The PV11 parametric form is a display-referred construct and doesn't translate cleanly. The re-derivation is described in [`03-algorithms.md`](./03-algorithms.md) and the one-week slider recalibration pass tunes the knee shapes against reference images.

---

### 9.3 Richardson-Lucy capture sharpening — SUPERSEDED

**Status.** Superseded by 9.51 once the scene-referred redesign elevated RL to a v1 deliverable. The historical recommendation below ("v2, export-only") is obsolete.

**Historical note.** The original question asked whether to wire `MetalCaptureSharpening` into the pipeline; the answer used to be "v2, export only". The scene-referred pipeline has enough dynamic range in the pre-tone-map signal that RL's tendency to over-sharpen aliased edges is much less pronounced — the signal it sharpens is pre-AgX scene-linear, so the edges it over-shoots get compressed by the view transform's highlight shoulder. That makes RL palatable on the interactive path. See 9.51 for the remaining tuning questions.

---

### 9.4 Vibrance hue window — RESOLVED

**Decision.** The skin-protection hue window remains a smoothstep in Oklab hue-angle space (see [`03-algorithms.md`](./03-algorithms.md) § 3.7). The current heuristic endpoints `smoothstep(15°, 22°, hue) * (1 - smoothstep(35°, 42°, hue))` are placeholders pending a **pre-ship calibration pass** that produces locked numeric values. Endpoints are not user-tunable — they're a precision-calibration parameter, not a creative slider; a "skin tone hue offset" knob would invite the class of UX confusion ("why are my skin tones turning orange?") that a well-tuned fixed default avoids. Users wanting non-standard behavior author creative LUTs.

**Reference set.** 30 portraits, three-axis coverage:

- **Skin tone** — Fitzpatrick scale I–VI (6 categories, ~5 portraits each).
- **Lighting** — daylight, tungsten, overcast, golden hour, fluorescent, mixed (sprinkled across the set).
- **White balance** — 2–3 portraits intentionally shot under unusual WB so vibrance behavior is tested when the input chroma already has hue drift.

Sourcing the set with documented Fitzpatrick categorization, varied lighting, and WB metadata is real effort and is part of the calibration deliverable.

**Tuning workflow.** Two phases:

1. **Manual tuning pass.** Render each of the 30 portraits at vibrance = +50 and adjust the four smoothstep endpoints iteratively until skin tones across all 30 stay perceptually close to the input. Human judgment work — no metric exists for "skin looks natural" beyond a calibrated reviewer.
2. **Lock and freeze.** Once endpoints are locked, the vibrance outputs on the 30-image set become **golden images** in the test corpus. CI gate then catches any regression in vibrance output (pixel diff to 1e-4 linear, same tolerance as the rest of the parity gates).

**Cannot ship without this calibration locked.** New gate in [`11-testing.md`](./11-testing.md).

**Where it lives.** [`03-algorithms.md`](./03-algorithms.md) § 3.7 (smoothstep endpoints become spec constants once calibration produces them). Calibration gate: [`11-testing.md`](./11-testing.md) § Render gates.

---

### 9.5 Clarity/texture resolution scaling — RESOLVED

**Decision.** Scale unsharp radii by image long edge with reference at 2000px:

```
actualRadius = referenceRadius * (imageLongEdge / 2000)
```

Reference radii: clarity = 40px at 2000px long-edge, texture = 3px at 2000px long-edge. So a 40% clarity setting on an 8000px-long-edge export uses a 160px radius; on a 1000px preview it uses 20px. Same perceptual scale across resolutions.

**Why long-edge over total pixel count or DPI.** Long-edge scales with linear features the user perceives (the size of a face, a building, a flower) regardless of aspect ratio. Total pixel count would penalize portrait crops; DPI requires output medium info we don't have at preview time. Long-edge matches Adobe's apparent behavior in side-by-side tests on the same image at different export sizes.

**Where it lives.** [`03-algorithms.md`](./03-algorithms.md) § 3.8 (Clarity/Texture, the radius scaling note becomes the implementation, not a known limitation).

---

### 9.6 Per-channel vs Oklab-L clarity — PARTIALLY RESOLVED

**Decision for v1.** Per-channel scene-linear unsharp for both Clarity and Texture.

**Decision for v2.** Re-evaluate Oklab-L clarity (not Lab-L — we've adopted Oklab as the perceptual chroma space; Vibrance already lives there; see [`03-algorithms.md`](./03-algorithms.md) § 3.7).

**Where it lives.** [`03-algorithms.md`](./03-algorithms.md) § 3.8 Clarity/Texture.

**Why.** The scene-referred move changed the failure mode. Per-channel Clarity in display-referred P3 caused visible hue shifts on saturated edges because those edges were already compressed into gamut. In scene-linear Rec.2020 the edges have headroom; the per-channel artifact is quieter. The remaining case for Oklab-L is cleaner highlight sharpening on high-saturation reds and blues, which is noticeable but not v1-blocking.

**Remaining open sub-question.** Does Oklab-L Clarity produce obviously better results than per-channel scene-linear on the reference image set? Run a visual comparison pass in v2 before committing to the migration. Texture stays per-channel regardless (radius is small, difference is negligible).

---

### 9.7 Full dehaze on the interactive path — RESOLVED

**Decision.** Full dark-channel prior on every path. Interactive runs the full algorithm on a **¼-size buffer**, upsamples the transmission map to full resolution (bilinear is sufficient — transmission is low-frequency by construction), and applies the upsampled map at full res. Export runs the full algorithm at full resolution. The visual difference between interactive ¼-res transmission and export full-res transmission is well below visible threshold for the kinds of haze gradients real photos contain. The contrast-boost-and-gamma-adjust approximation is dropped from the interactive path entirely.

**Why.** Same principle as 9.51 (RL): preview is the truth. A user editing at +75 dehaze and seeing a different image on export is a confidence killer; the spec's whole point is that the viewport accurately represents the export. The ¼-size optimization preserves the algorithmic correctness while keeping the interactive cost down. The dark-channel prior's transmission map is inherently low-frequency (it estimates atmospheric scatter, which varies smoothly across a scene), so the ¼-res approximation introduces no perceptible artifacts vs full-res transmission.

**Where it lives.** [`03-algorithms.md`](./03-algorithms.md) § 3.9 (Maple's simplification section is replaced by the ¼-size interactive description).

---

### 9.8 X-Trans support

**Question.** Fuji's X-Trans CFA requires Markesteijn or VNG demosaic. Maple's AMaZE/HA can't handle it.

**Current behavior.** Apple: fallback to CIRAWFilter (which supports X-Trans). Web: no fallback; X-Trans is unusable on web.

**Why unresolved.** Implementing Markesteijn in Rust is ~500 lines. Its design is published; RT's implementation is a reasonable reference. The effort is justifiable but not urgent — X-Trans is Fuji-only, and Fuji shooters are a minority of the target audience.

**Recommendation.** Add Markesteijn to `raw-core` in v2. Until then, web users with Fuji files should be shown a clear "Fuji RAWs not supported on the web in v1" message rather than a silent demosaic artifact.

---

### 9.9 Dead-pixel and hot-pixel correction

**Question.** Sensor defects aren't corrected. Long-exposure astrophotography will show hot pixels; aging sensors show dead pixels.

**Current behavior.** None.

**Why unresolved.** The feature requires either a user-maintained defect map (tedious) or automatic detection (expensive and error-prone at tight thresholds).

**Recommendation.** Defer to Phase 4+. Not a pressing user need for the target audience.

---

### 9.10 Highlight reconstruction — RESOLVED

**Decision.** Ships with two modes co-resident: **Blend** (default for the toggle) and **Luminance Recovery** (mode picker for power users). Pipeline slot is internal to `raw-core`, between demosaic (§ 3.3) and DCP color transform (§ 3.4) — § 3.3a `HighlightReconstruction`. XMP key: `papp:HighlightRecoveryMode` with values `"off"` (default) | `"blend"` | `"luminance"`. Lands when the algorithm is calibrated against the reference scene set; not gated on any prior release.

**Why.** Channel-clip information disappears once the DCP matrix runs, so reconstruction has to live before stage 3.4 — pipeline placement is forced. Co-shipping both modes avoids a UX migration where the toggle later grows into a mode picker. The scene-referred + AgX architecture is what makes this feature work — extrapolated values above 1.0 land on AgX's shoulder gracefully — so this is the natural home for it. Calibration is a person-week against a reference scene set (sunsets, snow, neon, stage-lit concerts, specular metal); Blend's failure modes are gray-haze clouds and drifted-cyan skies, LR's are halos at hard specular edges. Done right means doing the calibration pass before shipping.

**Where it lives.** Pipeline slot: [`02-pipeline.md`](./02-pipeline.md) § Filter chain (note on stage 1 — sub-stage lives inside `raw-core`). Algorithm: [`03-algorithms.md`](./03-algorithms.md) § 3.3a HighlightReconstruction. XMP field: [`08-io.md`](./08-io.md) § Field coverage.

---

### 9.11 Lens corrections (distortion, vignetting, CA)

**Question.** Maple applies no lens correction. Lightroom reads lens profiles and corrects geometric distortion, vignetting, and lateral chromatic aberration automatically.

**Current behavior.** None.

**Why unresolved.** Requires a lens profile database (Adobe's is closed; `lensfun` is open-source but maintenance-sparse), plus the geometry correction stage in the pipeline.

**Recommendation.** Phase 4 item. Start with the lensfun database and simple distortion/vignetting correction. Lateral CA is separate and harder.

---

### 9.12 Noise reduction on web — PARTIALLY SUPERSEDED

**Status.** Superseded by 9.52, which documents that the web NR is now a scene-linear bilateral filter in v1 (not skipped). The "visually comparable but not pixel-for-pixel identical to Apple" policy stands; 9.52 tracks the remaining question of how much divergence is acceptable at high slider values.

---

## Color management

### 9.13 CIRAWFilter color differences

**Question.** Images decoded via the CIRAWFilter fallback don't go through Maple's DCP transform. Their color rendering is Apple's choice, which differs visibly from the Rust path (~2–5 ΔE typical, more at the extremes).

**Current behavior.** No reconciliation; fallback is "whatever Apple decided".

**Why unresolved.** For cameras where the Rust path works, the Rust rendering is canonical. But for X-Trans and other fallback cases, users get Apple's rendering. If a user edits a DNG with the Rust path and the same DNG with the CIRAWFilter path (e.g., across devices), the edits are calibrated to different color spaces.

**Recommendation.** Expand rawler coverage to eliminate fallback where possible. For the remaining fallback cases, document the color difference as a known asymmetry. Don't attempt to color-match CIRAWFilter output to the Rust output — that's a rabbit hole.

**Related.** 9.45 extends this question with the scene-referred policy: since CIRAWFilter output is already post-tone-mapped, the fallback path must skip AgX entirely. That compounds the asymmetry — a CIRAWFilter-decoded image and a rawler-decoded image render to different display values even beyond the historical 2–5 ΔE, because they've passed through different view transforms. Read 9.45 alongside this one.

---

### 9.14 LCMS (portable ICC library)

**Question.** Should Maple bundle LCMS2 in the Rust core for arbitrary ICC profile handling?

**Current behavior.** Only the four spaces Maple needs (Linear Rec.2020 D65 working, Display P3, sRGB, and ProPhoto for DNG reference matrices) are supported, via compiled constant matrices. Arbitrary input profiles aren't handled.

**Why unresolved.** LCMS2 is mature, but adding it grows the Rust core's binary size meaningfully and introduces a new FFI surface. The scene-referred redesign narrowed the motivation — the old "gamut mapping on export" case (9.15) is now handled by AgX without any ICC machinery, so the only remaining case is exotic embedded profiles on JPEG/TIFF input.

**Recommendation.** Not for v1. Maple's input formats (RAW + standard JPEG/HEIC/PNG/TIFF) rarely carry exotic profiles. If the need arises, add it narrowly — profile conversion only, not rendering intents.

---

### 9.15 Gamut mapping on export — RESOLVED

**Decision.** The AgX view transform provides built-in gamut compression as part of its sigmoid. There is no separate "hard clip" stage for display-referred exports. The Rec.2020 → target (sRGB or Display P3) matrix still runs, but it acts on post-AgX values that already sit inside a well-behaved gamut; remaining out-of-gamut excursions are negligible and clamped at the final quantization step without visible color shifts.

**Where it lives.** [`04-color-management.md`](./04-color-management.md) § Export and § View transform.

**Why.** The whole reason the original question existed was that display-referred pipelines have no graceful gamut-handling story — they clip. A scene-referred pipeline with a real view transform solves this structurally. No ICC library, no "Perceptual" preset, no knee-curve desaturation hack — AgX's tone mapping is simultaneously a gamut compression curve.

**Caveat.** Scene-linear exports (TIFF-scene, EXR) skip AgX entirely and write unclipped Rec.2020 D65 values — negatives and values > 1.0 pass through. That is the _point_ of scene-linear export; it preserves the full state for downstream work. See [`08-io.md`](./08-io.md) § Export.

---

### 9.16 f16 vs f32 in deep shadows — RESOLVED

**Decision.** f32 throughout the interactive working pipeline on all platforms. No user toggle.

**Where it lives.** [`05-performance.md`](./05-performance.md) § GPU/CPU split and § iOS memory budget; [`02-pipeline.md`](./02-pipeline.md) § Web pipeline uses `RGBA32F` textures.

**Why.** The scene-referred pipeline carries highlight values well above 1.0 and applies a nonlinear tone curve (AgX sigmoid) in shader. f16's effective dynamic range is too narrow for the intermediate products — banding appears not just in deep shadows but in mid-tone sigmoid knees on pushed exposures. f32 is non-negotiable for the math we've chosen.

**Memory consequence.** Working-texture memory doubles. On older iPads (A14 and below) this forces tiling at >20MP (vs. >38MP on M-series and never at 25MP on desktop). The tile policy is documented in [`05-performance.md`](./05-performance.md) § Older iPad tiling policy.

**Web consequence.** WebGL2 `EXT_color_buffer_float` becomes mandatory. Safari ≥ 16 and Chrome ≥ 81 support it; older browsers are shown a blocking "unsupported" notice on editor load.

---

## Cross-platform and FFI

### 9.17 Web worker decode

**Question.** WASM decode blocks the main thread for ~1–2s on large RAWs. Should it be moved to a worker?

**Current behavior.** Main-thread decode; spinner shown; UI frozen until done.

**Why unresolved.** Workers have a messaging overhead that conflicts with the zero-copy upload pattern (`Float32Array` over WASM memory). The decoded buffer must be `postMessage`-transferred, which involves a copy unless `Transferable` is carefully used.

**Recommendation.** Move to a worker in v2. Use `SharedArrayBuffer` where available (COOP/COEP headers permitting) to avoid the copy; otherwise accept the one-copy overhead (decode is already slow, one 400MB copy adds ~80ms).

---

### 9.18 Web export tiling — RESOLVED

**Decision.** Full tiling on web, parity with native. `tile.rs` is callable from WASM with the same tile-planning logic the Apple pipeline uses (planar bands or quadtree depending on filter footprint). Tile size is **fixed-conservative at 12MP per tile** — predictable, oversized tiles never appear, no failure-recovery code path. Probe-and-adapt is a later optimization if telemetry shows users hitting the cap on unusually constrained browsers. Cross-tile-aware filters (clarity radius 40, capture sharpening, NR) read with overlap regions; same overlap arithmetic as Apple — port, do not re-derive. No half-resolution fallback option for export. The export dialog has separate "long edge" / "max megapixels" resize controls (a normal feature, not a memory workaround). Progress UI in the dialog is required (multi-tile WebGL exports take real seconds).

**Stitching parity test.** A CI test renders the same RAW via Apple's full-resolution path and the web's tiled path and asserts agreement to **1e-4 linear** (same tolerance as AgX parity). This is the test that catches "looks fine, has a 1-pixel seam down the middle."

**Why.** Maple's audience shoots 33–100MP cameras. Anything ≥33MP — Sony A7 IV, A1, A7R V, Canon R5, Fujifilm GFX, Hasselblad — fails the un-tiled web export today. The post-f32 ceiling near ~25–30MP is the hard wall. A complete editor renders any RAW at full resolution on every platform; everything else is a workaround that erodes trust over time. Doing it properly means tiling, overlap-aware filters, and a parity test that catches stitching regressions before users do.

**Where it lives.** [`06-cross-platform.md`](./06-cross-platform.md) § FFI: Rust → Web (WASM memory cap) and § iPad vs web parity (export tiling drops out of the asymmetries table). Tile planner reused from the Apple path.

---

### 9.19 Color-derivation script — RESOLVED

**Decision.** Ship `tools/derive_matrices.py` (Python, numpy) as a v1 near-blocker before any slider calibration work. Single source of truth for the constant color matrices; DCP per-camera matrices are runtime-parsed and out of scope.

**Scope.** The script emits, from first principles (primary chromaticities + illuminants + Bradford CAT):

- `M_PRO_TO_REC2020` (DCP exit with D50→D65 Bradford)
- `REC2020_TO_P3`, `P3_TO_REC2020`
- `REC2020_TO_SRGB`, `SRGB_TO_REC2020`
- `REC2020_TO_OKLAB_LMS`, `OKLAB_LMS_TO_REC2020` (Vibrance working space)
- `AGX_INSET`, `AGX_OUTSET` (AgX internal primary rotation)
- `BRADFORD_D50_D65`, `BRADFORD_D65_D50`

**Not in scope:**

- DCP per-camera matrices (parsed at runtime from the DCP blob).
- The AgX sigmoid LUT (tabular data, handled by `tools/derive_agx_lut.py` which emits `agx_lut.bin` + parity metadata).

**Emit format.** f32 literals (rounded at emit time; f64 intermediate printed to adjacent comment lines for audit). Three generated files:

- `raw-pipeline/crates/raw-core/src/matrices.rs`
- `src/apple/Packages/MapleCore/Sources/MapleCore/Generated/Matrices.swift`
- `src/web/projects/editor/src/app/pipeline/generated-matrices.ts`

Each file has a `GENERATED — DO NOT EDIT` header, the script version, and a hash of the chromaticity inputs.

**CAT choice.** Bradford only. Sharpened variants and CAT02 are explicitly not used; if that ever changes it's a one-line constant swap + regeneration.

**CI parity check.** A CI job runs the script and diffs against committed files. Build fails on any mismatch. Catches both "someone hand-edited the generated file" and "someone changed chromaticities but forgot to regenerate."

**Version bumping.** The script carries its own version integer; any change to chromaticities or CAT choice bumps it and forces regeneration of all three target files. Independent of `papp:ViewTransformVersion` (9.44) — matrix changes can and should cascade into a view-transform bump, but the matrix script owns its own lineage.

**Where it lives.** Script at `tools/derive_matrices.py`; CI at the project's standard test runner; outputs referenced from [`04-color-management.md`](./04-color-management.md) § Matrix constants and [`06-cross-platform.md`](./06-cross-platform.md) § Matrix parity.

---

### 9.20 Shader testing infrastructure

**Question.** There's no automated test comparing the MSL and GLSL shader outputs for the same inputs.

**Current behavior.** Parity is checked manually via the visual pipeline harness.

**Recommendation.** Build a test harness that runs both shaders against a fixed input texture and compares outputs with a small ΔE budget. Nontrivial infrastructure (must drive both Metal and WebGL2 from a test runner) but would prevent quiet drift between platforms.

**Updated scope post scene-referred.** Three kernels now need parity coverage: `SceneToneControls`, `SceneVibrance`, and `AgXViewTransform`. The AgX parity test (see 9.53 and [`06-cross-platform.md`](./06-cross-platform.md) § AgX parity) uses a tighter `1e-4` linear-output tolerance rather than a ΔE budget, because a view-transform drift of a few ΔE would be catastrophic across platforms. Prioritize AgX parity over the other two.

---

## UI and interaction

### 9.21 Pin-zoom preference

**Question.** Navigating between images always resets zoom. Should it preserve zoom for pixel-peeping a series?

**Current behavior.** Zoom resets on navigation.

**Recommendation.** Phase 3 preference: "Preserve zoom across images". Default off. When on, zoom position persists within the filmstrip session.

---

### 9.22 iOS share sheet

**Question.** Export on iOS bypasses the share sheet. Users can't send directly to Messages, Mail, etc.

**Current behavior.** Writes to Photos library or Documents only.

**Recommendation.** Phase 5. The share sheet on iOS is `UIActivityViewController`; wiring it is a few hours, but fitting it into the Export UX requires a sheet-presentation design pass.

---

### 9.23 Batch editing

**Question.** Paste-adjustments works one image at a time. Selecting multiple thumbnails and pasting to all is common.

**Current behavior.** One at a time.

**Recommendation.** Phase 4. The underlying pipeline supports it; the UI needs multi-selection in the grid and a "Paste to Selection" button. Straightforward.

---

### 9.24 Accessibility gaps

**Question.** Slider tracks have marginal contrast; Dynamic Type above Large breaks layout.

**Current behavior.** WCAG AA for body text; sliders don't audit cleanly.

**Recommendation.** Phase 5 accessibility audit. The design-token system supports it; just requires doing the work and fixing the layout breakpoints.

---

### 9.25 Benchmark harness

**Question.** There's no automated performance regression harness.

**Current behavior.** Manual benchmarking; regressions noticed only if visible.

**Recommendation.** Build `tools/benchmark.sh` that runs the pipeline against a fixed RAW, measures fast-phase and refine-phase timings, and fails if they regress by > 20%. Not a blocker; a strong want.

**Updated scope post scene-referred.** 9.48 identifies a specific requirement: per-generation iPad benchmarks at 12/20/25/38/50 MP to validate the tile-mode thresholds. That work is cleanest if it lives inside this benchmark harness rather than as one-off scripts. Treat the harness as a dependency of 9.48.

---

## I/O and persistence

### 9.26 Full sidecar/library sync

**Question.** The server spec describes sync, but v1 runs fully local. When the server is wired, how are conflicts resolved across devices?

**Current behavior.** v1 is local-only.

**Recommendation.** Server sync in Phase 5. Use vector clocks on sidecar writes (each client ID + sequence number); conflicts resolved by "latest wins with keep-other-as-backup" — the loser is stashed as `IMG_0001.conflict-20260422.xmp` for user review. Not painless, but transparent.

---

### 9.27 Selective metadata strip

**Question.** The export "strip metadata" toggle is binary and blunt. Real users want "strip GPS, keep everything else" or "strip serial, keep creation date".

**Current behavior.** Binary toggle; partial impl (only profile and GPS and serial are stripped).

**Recommendation.** Phase 5 UX: a three-section checkbox list (Location, Camera, XMP/IPTC) or an advanced "Include individual fields" panel. The metadata-handling code is ready; it's a UX design task.

---

### 9.28 PhotoKit CI testing

**Question.** PhotoKit integration tests can't run in CI today.

**Current behavior.** Tested on-device only.

**Recommendation.** Use `xcrun simctl photos` to inject test photos into the simulator Photos library, then run integration tests on the simulator. Nontrivial CI setup. Phase 5 if PhotoKit coverage becomes a regression hotspot.

---

### 9.29 Orphan sidecar sweeper — RESOLVED

**Decision.** Two-phase sweep with trash quarantine. On app launch (debounced to once per 24h via a `UserDefaults` timestamp, scoped to the PhotoKit source), gate the entire sweep on `PHPhotoLibrary.authorizationStatus(for: .readWrite) == .authorized` — skip silently for `.limited`, `.notDetermined`, `.denied`, `.restricted`. Iterate `~/Library/Application Support/MapleMaple/sidecars/*.xmp`, batch-fetch identifiers (500 at a time) via `PHAsset.fetchAssets(withLocalIdentifiers:)`, and for each unresolved identifier `mv` the sidecar into `~/Library/Application Support/MapleMaple/sidecars/.orphaned/{YYYY-MM-DD}-{identifier}.xmp`. Same run, second pass: delete anything in `.orphaned/` whose date prefix is ≥30 days old. Sweeper runs silently — no UI surfacing in v1.

**Why.** A bare delete is unsafe because `fetchAssets` returns empty for several non-deletion reasons (Limited Photos subset misses, mid-load on launch, iCloud metadata lag, asset in Recently Deleted). The authorization gate handles Limited Photos at the policy level; the quarantine handles every other transient case by giving the user 30 days to recover (matching Apple's Recently Deleted convention) without inventing a parallel state file — the directory listing is the state. Silent operation matches the "trivial / ~50 lines" framing; we can add a diagnostics surface if telemetry ever shows the sweeper misbehaving.

**Where it lives.** [`08-io.md`](./08-io.md) § Sidecar storage strategy (PhotoKit asset behavior) and § `PhotoKitSource` (deletion sweep mechanics).

---

### 9.30 SMB concurrent write

**Question.** When two clients write the same sidecar over SMB simultaneously, AMSMB2 doesn't expose advisory-lock semantics.

**Current behavior.** Last writer wins. Rare in practice; unhandled.

**Recommendation.** Detect via mtime monitoring (already planned in 9.26) and surface conflict UI. No reliable lock available; this is the best we can do.

---

## Platform roadmap

### 9.31 Presets engine

**Question.** Copy-paste of adjustments exists; saved presets don't.

**Current behavior.** No preset system.

**Recommendation.** Phase 3. Preset = named `AdjustmentModel`; stored at `~/Library/Application Support/MapleMaple/presets/`. Apply = replace current model's non-null fields with preset's non-default fields. Good for shoot-consistency workflows.

---

### 9.32 Before/After

**Question.** Basic editing feature missing in v1.

**Current behavior.** None.

**Recommendation.** Phase 3. Toggle view between current render and `originalModel` render. Split-screen and swipe variants both straightforward given the pipeline's purity.

---

### 9.33 Histogram and scopes

**Question.** Scopes tab is placeholder.

**Current behavior.** No real implementation.

**Recommendation.** Phase 3. Histogram is a simple GPU reduction (512-bucket, per-channel). Waveform and vectorscope are render-to-texture ops. Target: all three live-update on slider changes.

---

### 9.34 Curves UI — SUPERSEDED

The Curves panel is fully spec'd by 9.49 (log-log AgX-encoded axes, two-line AgX overlay) and 9.50 (the display-referred sub-panel for Lightroom-imported curves). Implementation lives in [`07-ui-architecture.md`](./07-ui-architecture.md) § Curves panel. No remaining open question.

---

### 9.35 HSL panel

**Question.** Per-color hue/saturation/luminance adjustments are a Lightroom staple. Not implemented.

**Current behavior.** None.

**Recommendation.** Phase 3. Eight color ranges (red, orange, yellow, green, aqua, blue, purple, magenta). Extends `AdjustmentModel` with 24 new fields (8 × 3) and the `crs:` namespace has the schema ready.

---

### 9.36 Masking

**Question.** Local adjustments (mask a region and apply separate sliders) are Phase 4. The sidecar passthrough preserves Lightroom's masks already.

**Current behavior.** Passthrough only — Maple doesn't interpret or render masks.

**Recommendation.** Phase 4. Start with simple geometric masks (linear gradient, radial gradient), then add subject/sky detection via Apple's Vision, then brush masks. Significant scope.

---

### 9.37 Panorama stitching

**Question.** [`maple-maple-panorama-spec.md`](../maple-maple-panorama-spec.md) describes a full stitching pipeline. Not implemented.

**Current behavior.** None.

**Recommendation.** Phase 4. Follow the existing spec.

---

## Architectural

### 9.38 SwiftData scaffolding

**Question.** The Xcode template left SwiftData placeholders (`Item` model, `ModelContainer`). They aren't used by the real pipeline.

**Current behavior.** Scaffold code present but inert.

**Recommendation.** Delete on next cleanup pass. The CLAUDE.md note already says so; just hasn't happened.

---

### 9.39 Server: is it actually needed for v1?

**Question.** The server spec is ambitious. v1 doesn't require it — local + SMB covers most use cases. Should the server effort be deferred entirely?

**Current behavior.** Server is design-phase; not running in production.

**Recommendation.** Defer server to Phase 5. Ship v1 local-only. The XMP round-trip guarantees that adding server sync later is a pure additive — existing sidecars remain canonical.

---

### 9.40 Plugin API

**Question.** Deferred to Phase 5. What's the shape?

**Current behavior.** None.

**Recommendation.** Don't design it yet. The pipeline is currently fixed-order; opening it to plugins commits to an order that won't change. Wait until Phase 4 masking is done and the real pipeline boundaries are clearer.

---

## Dead code and cleanups

### 9.41 Template `ContentView` / `Item`

Already covered in 9.38. Delete on next cleanup.

### 9.42 MetalCaptureSharpening

Not wired. Keep the kernel (it's good code and tested separately); remove it from the build until it's wired. See 9.3.

### 9.43 `papp:` namespace usage

Live `papp:` fields after this walkthrough: `papp:ViewTransformVersion` and `papp:AgXLook` (9.44), `papp:HighlightRecoveryMode` (9.10), `papp:SceneLinearToneCurve` / `…Red` / `…Green` / `…Blue` (9.50). The namespace also reserves space for future masks, snapshots, and panorama refs per the feature spec. The prefix declaration is required regardless of usage; don't remove it.

---

## Scene-referred follow-ups

These questions surfaced once the scene-referred + AgX redesign landed. They are new in v1 scope.

### 9.44 View transform versioning and roaming — RESOLVED

**Decision.** Sidecars carry `papp:ViewTransformVersion = "agx-N"` where N is a monotonically-increasing integer. The binary ships every historical version (≤200 bytes of coefficients + optional 6KB LUT per version; ~100KB total at 20 versions is fine). Looks are orthogonal: `papp:AgXLook = "neutral" | "punchy" | "golden"` is a separate user preference, not part of the version contract.

**What triggers a version bump:** any change to AgX coefficients (`MIN_EV`, `MAX_EV`, `MID_GRAY`), sigmoid base slope or pivot, the contrast-slider → effective_slope mapping, the AgX inset primaries matrix, the 512×3 sigmoid LUT content, or gamut compression behavior. Pipeline-ordering changes outside AgX do not bump. New look variants do not bump.

**Mismatch behavior.**

| Sidecar tag                 | Device state            | Behavior                                                                                                                                                                                                                                                                         |
| --------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Known (older or equal)      | Device has that version | Render with the tagged version. No banner. Edits preserve the tag. A menu item _Re-render with current view transform_ offers explicit upgrade.                                                                                                                                  |
| Unknown (newer than device) | Device doesn't have it  | Render best-effort with the device's current version. Status-bar indicator surfaces the mismatch. Any save attempt triggers a modal: "This file was edited with a newer view transform (agx-7). Saving will re-stamp with your installed version (agx-5). Continue / View only." |
| Missing (no tag at all)     | Any device              | Treat as `agx-1`. Stamp with current version on first save. Covers Lightroom imports and pre-release Maple sidecars.                                                                                                                                                             |

**Cache-key interaction.** `RenderedPreviewCache` and the thumbnail cache both include `viewTransformVersion` in their keys (see [`05-performance.md`](./05-performance.md)). A user who upgrades Maple from agx-5 to agx-6 and opens a previously-cached agx-5 edit gets a cache miss, re-renders, and — because the sidecar still says agx-5 — gets the agx-5 result. The cache correctly reflects the rendering, not the local version.

**Where it lives.** [`04-color-management.md`](./04-color-management.md) § View transform versioning, [`05-performance.md`](./05-performance.md) § RenderedPreviewCache, [`08-io.md`](./08-io.md) § XMP wire format (new `papp:` fields).

---

### 9.45 CIRAWFilter scene-referred policy — RESOLVED

**Decision.** Accept the asymmetry. CIRAWFilter-decoded files render with Apple's baked-in tone mapping (no AgX on top); the scene-linear chain's sliders calibrate to the rawler path only. A small "CIRAWFilter" badge in the Info panel surfaces the fallback state without an intrusive banner. No dual slider calibration. No attempt to linearize Apple's output.

**Why not (B) inverse tone curve:** Apple doesn't publish their curve; any inversion is an approximation that accumulates error through the AgX shoulder. Worse, Apple can change the internal tone mapping in an OS update and break us silently. Recurring engineering tax for a minority path is not justified.

**Why not (C) dual calibration:** Bakes the fallback permanence into the data model. When Markesteijn lands in `raw-core` (9.8), Fuji moves to the rawler path and the dual-calibration ghost becomes a maintenance hole.

**Fallback pipeline (same as before):**

1. Decode via CIRAWFilter to P3 linear.
2. Apply a P3→Rec.2020 matrix (pure chromatic remap, no tone operation).
3. Feed into the scene-linear chain starting from stage 5 (masking / curves / clarity) — skip stages 1–4 (demosaic, raw-WB, camera-matrix, DCP) because CIRAWFilter already handled them.
4. Skip AgX (stage 12). The image is already post-tone-map.
5. Continue to gamut + transfer encode (stages 13–14).

**UI surface.** Info panel shows a small `CIRAWFilter` badge on files decoded via the fallback. No banner, no modal, no blocking. Users who care can hover for the tooltip explaining the different rendering path; users who don't can ignore it.

**Follow-up commitment.** Adding Markesteijn to `raw-core` (9.8) closes this hole for X-Trans specifically. Consider promoting 9.8 to v1.x if mixed Fuji + other-brand libraries become a common user pattern; otherwise v2.

**Where it lives.** [`04-color-management.md`](./04-color-management.md) § CIRAWFilter fallback, [`03-algorithms.md`](./03-algorithms.md) § 3.4, [`07-ui-architecture.md`](./07-ui-architecture.md) § Info tab (CIRAWFilter badge — stub).

---

### 9.46 Scene-linear TIFF reference white

**Question.** A 16-bit half-float scene-linear TIFF in Rec.2020 has no hard "diffuse white = 1.0" convention. Different downstream tools (Nuke, Resolve, Photoshop with OCIO) disagree. What value do we write at the "diffuse white" point?

**Current direction.** Write `1.0` at scene-linear diffuse white (i.e., the value a correctly-exposed 18% gray card's white patch would produce after WB and DCP). This matches the OpenColorIO ACEScg convention and the Blender filmic default.

**Unresolved sub-question.** Does any target tool assume `0.18` = diffuse white (mid-gray referred)? If so, document the offset in the export dialog.

**Where it lives.** [`08-io.md`](./08-io.md) § Export, formats table.

---

### 9.47 EXR export — RESOLVED

**Decision.** EXR ships alongside scene-linear TIFF in the first release. **Single encoder unified on the Rust `exr` crate**, compiled for both Apple FFI and WASM. Metadata defaults: chromaticities = Rec.2020 primaries + D65; `displayWindow` and `dataWindow` identical and equal to image bounds; compression = **PIZ** (wavelet, lossless, photographic-content optimum) with **ZIP** as an alternate for synthetic/smooth-gradient content; channel precision = **half** (f16) by default with **float** (f32) as the precision-critical alternate; channel layout = `R, G, B` (no alpha until masking ships). No lossy compression options exposed (B44, DWAA) — anyone reaching for EXR wants full precision.

**Validation.** Blender round-trip CI test as a new gate in [`11-testing.md`](./11-testing.md): render a known scene to EXR via Maple, open in Blender's compositor (headless, scriptable), re-export from Blender, re-import into Maple, assert pixel parity to **1e-4 linear** (same tolerance as AgX and the web tiling parity tests). Catches metadata mistakes — wrong chromaticities, wrong window, off-by-one channel layout — that wouldn't fail loudly otherwise. Nuke validation is a manual pre-release gate, not CI.

**Why.** Both scene-linear export formats target the same audience (VFX, compositing, scene-referred-aware editors); shipping one without the other forces that audience to use a workaround. Unified encoder is consistent with Maple's "Rust core, thin platform bindings" architecture, gives automatic numerical parity, and means the round-trip test only has to cover one encoder. The Rust `exr` crate is mature and used in production photo tools; if a real bug surfaces against canonical OpenEXR readers, the parity test gives us the signal and we have a clear fallback path to `libOpenEXR` on the affected platform.

**Where it lives.** [`08-io.md`](./08-io.md) § Export. Round-trip gate: [`11-testing.md`](./11-testing.md) § Render gates.

---

### 9.48 Older-iPad tiling benchmarks

**Question.** The tile policy in [`05-performance.md`](./05-performance.md) § Older iPad tiling policy assumes that f32 working memory at >20MP on A14-class iPads pushes over `recommendedMaxWorkingSetSize`. The exact threshold is inferred from Apple's public per-device memory numbers, not measured.

**Current direction.** Ship v1 with the conservative thresholds (tile at >20MP on A14/older). The policy is conservative enough that memory pressure failures shouldn't occur; the cost is that some users tile when they wouldn't need to.

**Unresolved sub-question.** Run a benchmark on each supported iPad generation (A12Z, A14, M1, M2, M3) with test images at 12/20/25/38/50 MP. Measure: does a single-pass render succeed, and at what point does tile-mode's overhead (seams, reload cost) dominate?

**Where it lives.** [`05-performance.md`](./05-performance.md); tracked in the benchmark harness once 9.25 is built.

---

### 9.49 Tone curve UI in log space — RESOLVED

**Decision.** The Curves editor uses **AgX's own log encode** for both axes (log-log). Range covers the full `ref_max = 4.0` curve domain — roughly −6.5 EV to +4.5 EV relative to mid-gray in AgX-log space. Tick labels at **−4, −2, 0, +2, +4 EV** (0 = mid-gray). Internal storage stays linear; the UI converts on read/write. A 45° line is the identity. The AgX sigmoid is overlaid as a **two-line composition**: the bold line is the user's authored curve (editable); the thin line is `AgX(user_curve(x))` mapped back into the editor's coordinates — i.e., what actually happens to an input value once the curve and view transform compose. Overlay is **on by default**, toggleable. Imported Lightroom curves render in a separate sub-panel labeled "Imported (display-referred)"; semantics deferred to 9.50.

**Why.** AgX-log axes (vs generic `log2(x/0.18)`) make the AgX sigmoid render _as_ a sigmoid in the editor — readable, and the user's coordinates match AgX's input domain. Log-log axes make the identity curve a 45° line and dragging feel symmetric in both directions; linear Y in a log X editor produces curves that bend unexpectedly. The two-line overlay is the closest analog to Capture One's "curve with output preview" UX and prevents the most common "why doesn't my curve match the image" confusion. The X-axis transform follows the active `papp:ViewTransformVersion` — a version bump that changes AgX's log encode re-axes the editor, which is a documented consequence of the version contract.

**Where it lives.** [`07-ui-architecture.md`](./07-ui-architecture.md) § Curves panel.

---

### 9.50 Lightroom curve import into a scene-referred pipeline — RESOLVED

**Decision.** **Two curve stages co-resident.** Maple's scene-linear curves stay where they are (inside `SceneToneControls`, stage 3). A new optional pipeline stage **12a `DisplayReferredCurve`** sits between AgX (stage 12) and the Rec.2020→target-gamut matrix (stage 13); it's active only when the sidecar carries a display-referred curve. Both stages can be live simultaneously and both round-trip through XMP losslessly.

**XMP namespace split.** `crs:ToneCurvePV2012*` always means **display-referred** in Maple's XMP (matches Lightroom's intent — a Maple-written sidecar with a display-referred curve is byte-correct for Lightroom's reader). Maple's scene-linear curves move to **`papp:SceneLinearToneCurve`**, **`papp:SceneLinearToneCurveRed`**, **`papp:SceneLinearToneCurveGreen`**, **`papp:SceneLinearToneCurveBlue`** — same `Seq` of `x, y` pairs in `0…255`, same nested-element form, but the `[0, 255]` domain maps to scene values `[0, ref_max]` rather than display `[0, 1]`. Pre-launch decision; no migration cost.

**Discrimination logic at import.** When a sidecar is loaded, `crs:ToneCurvePV2012*` is interpreted as follows:

- Sidecar carries any `papp:` markers (`papp:ViewTransformVersion`, `papp:AgXLook`, `papp:HighlightRecoveryMode`, `papp:SceneLinearToneCurve*`) → Maple-written; `crs:ToneCurve*` is display-referred and was emitted for Lightroom-readability. Load it into the stage 12a slot.
- Sidecar carries Lightroom markers (`crs:Version`, `crs:ProcessVersion`) but no `papp:` markers → Lightroom-written; `crs:ToneCurve*` is display-referred and goes into the stage 12a slot.
- Neither marker set present → assume display-referred (safer default; matches XMP convention).

**Editability.** The imported curve is editable. Once the user touches it, the UI label drops from "Imported (display-referred)" to "Display-referred curve" — it's now Maple-authored, not imported, but stays in display space and continues to round-trip with Lightroom. Display-referred curves are a real permanent feature, not a temporary import-compat hack.

**Export round-trip.** Maple writes whichever curve slots are populated:

- Scene-linear curves → `papp:SceneLinearToneCurve*`.
- Display-referred curves (imported or Maple-edited) → `crs:ToneCurvePV2012*` in Lightroom's exact byte format.

A Lightroom reader opening a Maple sidecar sees only `crs:`, gets the right display-referred curve, ignores `papp:`. A Maple reader sees both, applies stage 3 (scene-linear) and stage 12a (display-referred) independently.

**Why not re-derive mathematically (Option B from analysis)?** The conversion would require knowing Lightroom's view transform — proprietary, version-dependent. Approximating it via inverse-AgX produces a curve that doesn't round-trip identically when re-opened in Lightroom. For users who edit alternately in both apps, that's the wrong call. **Why not strip and warn (Option C)?** Hostile to Lightroom users; loses real authored work; the kind of thing that prevents adoption.

**Where it lives.** [`02-pipeline.md`](./02-pipeline.md) § Filter chain (new stage 12a). [`03-algorithms.md`](./03-algorithms.md) § 3.6b DisplayReferredCurve and § 3.6 (curve representation note). [`08-io.md`](./08-io.md) § Field coverage and § Sidecar import discrimination. [`01-data-model.md`](./01-data-model.md) § Tone curves table. [`04-color-management.md`](./04-color-management.md) § Interop. [`07-ui-architecture.md`](./07-ui-architecture.md) § Curves panel.

---

### 9.51 Richardson-Lucy capture sharpening — RESOLVED

**Decision.** Full algorithmic parity across paths and platforms. Apple interactive, Apple refine, Apple export, web interactive, web refine, web export — all run **3-iteration Richardson-Lucy** with **identical parameters**. Only image size varies (viewport vs full resolution); convergence is per-pixel so the iter count is constant. There is no path-split fallback to unsharp mask; if a viewport-sized RL pass doesn't fit the 16ms interactive budget on an M1 iPad, the fix is kernel optimization, not algorithm substitution. Web runs the same RL via WebGL2 fragment shaders (4 passes × 3 iter = 12 passes per render at viewport size — well within budget on every supported device).

**PSF kernel.** Fixed symmetric Gaussian, **default σ = 0.5px**, exposed as the existing `sharpenRadius` slider with range 0.5 … 3.0. XMP key remains `crs:SharpenRadius` for Lightroom interop; under RL the field is interpreted as the PSF Gaussian sigma rather than an unsharp blur radius. A Lightroom sidecar importing with `crs:SharpenRadius = 1.0` is read as PSF σ = 1.0 (soft-lens interpretation); user can tune. No per-camera-body or per-lens PSF database — defer permanently; if real demand surfaces, a per-body global softness estimate is a v1.x extension.

**Slider mapping.** `sharpenAmount` 0…150 maps to a mix weight between the unmodified scene-linear input and the RL output:

- 0 = stage skipped.
- 100 = full RL output (no mix).
- 100…150 = overdrive band — final unsharp pass on top of RL output, weighted ~0.5 at amount=150. For users who specifically want the look.

The 0…100 band is the principled range; 100…150 is for taste.

**Calibration as pre-ship gate.** A reference scene set covers the failure modes that bite RL specifically:

- Aliased edges (chain-link, brick, distant power lines) — RL can ring.
- Low-contrast detail (foliage, fabric, sand) — RL should sharpen without amplifying noise.
- Portrait skin — even slight over-sharpening is unflattering; the masking slider must clip cleanly.
- Bokeh boundaries (shallow DOF) — RL should respect the in-focus → soft transition.
- Specular highlights — RL can produce ringing halos; masking slider should suppress.

The calibration pass produces: the slider→mix-weight curve, the edge-mask attenuation parameters at each `sharpenMasking` value, and any per-path iter-count adjustment if 3 turns out wrong somewhere. **Cannot ship without this calibration locked.**

**Why algorithmic parity matters.** Maple's positioning is "the preview is the truth." A path-split where interactive shows unsharp and export ships RL produces a visible discrepancy when the user pixel-peeps before exporting — confidence killer. Same algorithm, same parameters, image size is the only variable.

**Web-specific note.** WebGL2 RL uses ping-ponged FBOs for the iteration; same `EXT_color_buffer_float` requirement that already gates the rest of the scene-referred pipeline (see [`05-performance.md`](./05-performance.md) § Fallbacks).

**Where it lives.** [`03-algorithms.md`](./03-algorithms.md) § 3.10. Cross-platform table: [`06-cross-platform.md`](./06-cross-platform.md) § iPad vs web parity. Calibration gate: [`11-testing.md`](./11-testing.md) § Render gates. Obsoletes 9.3 (already marked SUPERSEDED).

---

### 9.52 Web noise reduction parity

**Question.** Apple's NR uses `CINoiseReduction` rescaled to operate on scene-linear Rec.2020 inputs. Web uses a scene-linear bilateral filter. These produce different results — perceptually similar at moderate settings, divergent at `nrLuminance > 50`.

**Current direction.** Accept the asymmetry for v1. Document it in the web editor's Help panel. Target pixel-for-pixel parity is not pursued; target "visually comparable at typical slider values (`nrLuminance` ≤ 40)".

**Unresolved sub-question.** Is the divergence at high NR settings bad enough that a user's SMB-synced sidecar looks "wrong" when opened on web vs Mac? If so, consider implementing Apple's algorithm in the Rust core (shared path) instead of using the platform NR.

**Where it lives.** [`03-algorithms.md`](./03-algorithms.md) § 3.11, [`06-cross-platform.md`](./06-cross-platform.md) § Platform asymmetries.

---

### 9.53 AgX parity tolerance — RESOLVED

**Decision.** Keep `max abs error ≤ 1e-4 per channel` on the 256×256 synthetic test image covering the AgX domain (from `MID_GRAY * exp2(MIN_EV)` to `MID_GRAY * exp2(MAX_EV)`). Add a **one-time deliberate-perturbation sanity test** to verify that the threshold actually fires for realistic coefficient drift: perturb one entry of `AGX_COEFFS` in the Rust reference by 1%, confirm both the Apple and Web parity tests fail, then revert. If `1e-4` does not catch a 1% perturbation somewhere in the domain, tighten to `1e-5` and re-run the verification. The sanity test is a one-time pre-ship check, not a recurring CI gate.

**Why.** What `1e-4` is actually protecting against is coefficient drift between the three AgX implementations (Rust reference, Metal kernel, GLSL shader) — precision mismatches, transcription errors in the derivation script, missing intermediate casts. In the steep midtone region of the sigmoid, even a small (sub-1%) coefficient drift produces an output difference well above `1e-4`; in the flat toe/shoulder regions, the same drift produces a smaller output difference but the gate fires from the steep region first. So the worry that `1e-4` might be loose at toe/shoulder is real but doesn't matter — that's not where realistic drift would be caught. From the visibility angle, `1e-4` linear is roughly `0.025` in 8-bit, well below any quantization step or `ΔE` perception threshold. The right intervention isn't a different tolerance scheme; it's a verification that the chosen value does its job.

**Where it lives.** [`06-cross-platform.md`](./06-cross-platform.md) § AgX parity (Parity tolerance and the perturbation verification step).

---

## Tracking

This document is the intended home for _uncertainty_. When a question is resolved and a decision lands, move the item to the relevant spec doc (01 through 08) with a decision note, and delete it here. If a new ambiguity surfaces during implementation, add it here rather than making a silent choice.

A clean [`09-open-questions.md`](./09-open-questions.md) is not the goal. A list of _deliberate_, _documented_ uncertainties is.
