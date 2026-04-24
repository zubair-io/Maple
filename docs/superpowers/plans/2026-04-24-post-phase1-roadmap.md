# Post-Phase-1 Backlog — Sequencing Roadmap

**Date:** 2026-04-24
**Status:** Scoping only — each phase below gets its own detailed implementation plan before work starts.
**Source:** 2026-04-24 bug/feature backlog (P0 → P4).
**Relates to:** `docs/product-status.md` Phase 3 (Color Engine) + Phase 4 (Advanced Editing), plus cross-cutting perf.

## Why this is a roadmap, not a plan

The backlog spans 8 subsystems (cold-open perf, slider perf, tile cache, color science, crop/rotate, tone curves, lens correction, masking/local edits, CI plumbing). A single TDD plan would be 2000+ lines and impossible to review. Per `superpowers:writing-plans`: each independent subsystem gets its own plan. This doc is the index and sequencing argument.

## Global invariants (every phase must preserve)

- **Non-destructive.** Originals untouched; edits go to `.xmp` sidecars.
- **Scene-referred pipeline.** Nothing clips before the view transform.
- **One Rust core.** New color math lands in `raw-core`; platforms consume via xcframework / WASM.
- **Parity before features.** Apple↔Web ΔE gate blocks merge. Budgets only ratchet down.
- **Perf budgets.** Slider tick ≤16ms target, 50ms hard limit. Cold-open cached ≤35ms.

## Cross-phase dependencies

```
A (instrument) ──┬─> B (cold-open) ──┐
                 │                    │
                 ├─> C (slider) ──────┼─> D (tile cache) ──┐
                 │                    │                     │
                 ├─> E (color sci) ───┤                     ├─> F/G/H (features, parallel)
                 │                    │                     │
                 └─> (gates all perf claims)                ├─> I (parity + CI)
                                                             │
                                                             └─> J (masking) ─> K (local adj) ─> L (healing)
                                                                  │
                                                                  └─> P0.8 ROI refresh
```

Call-outs:
- **P0.0 (instrumentation) gates everything measurable.** No other P0 claim is provable without it — it's the first plan.
- **P0.8 (ROI refresh) depends on masking (LOCAL.1).** User flagged this; roadmap folds P0.8 into phase J.
- **E (color uplift) is core-only** and parallelizable with B/C. No platform coupling until parity ratchet (COLOR.5).
- **F/G/H (crop, tone curves, lens)** each touch raw-core + XMP schema + both shells. Independent of each other after C lands; can fan out.

---

## Phase A — Open + render instrumentation

**Backlog items:** P0.0.
**Goal:** Land signposts / `performance.mark` markers on Apple (os_signpost) and Web (Performance API) at: click → bytes → preview-paint → decode-done → first-paint → refine-done. Emit `maple-cli` latency markers too for the reference scene set.
**Size:** S.
**Why first:** Every P0 perf item claims a wall-clock win. Without shared instrumentation on both clients and CLI, wins are unmeasurable and regressions invisible. This plan also picks the reference scene set that later phases gate against.
**Plan file (to write):** `2026-04-25-phase-a-perf-instrumentation.md`
**Acceptance:** single CSV/JSON report per open event emitted on both shells + CLI, with a harness script to collect medians across the reference scene set.

---

## Phase B — Cold-open path (embedded previews + caches)

**Backlog items:** P0.1, P0.2, P0.3, P0.4, P0.9, PARITY.4.
**Goal:** First paint within one frame (~35ms) on cached, under ~250ms on cold.
**Content:**
- P0.1: Apple PhotoKit `PHImageManager.requestImage` opportunistic preview.
- P0.2: Apple Self-Hosted preview endpoint (reuse thumbnail or add `/preview` route).
- P0.3: flip `kCGImageSourceCreateThumbnailFromImageIfAbsent` to false (no synthesized preview fallback that blocks).
- P0.4: Web embedded JPEG preview on open (reuse WASM thumb extractor).
- P0.9: Web rendered-preview IndexedDB cache (key per caching.md: `primary_url, primary_mtime, sidecar_mtime, screen_size, adjustment_version, view_transform_version`).
- PARITY.4: Web disk cache for sourceless (source-less asset) thumbnails.
**Size:** M.
**Depends on:** A (for proof).
**Plan file (to write):** `2026-04-26-phase-b-cold-open.md`
**Acceptance:** Phase-A markers show preview-paint ≤35ms on cached first open across reference scene set on both shells.

---

## Phase C — Slider latency (two-phase + GPU + decoded-buffer + threading)

**Backlog items:** P0.5, P0.6, P0.7, P0.10, P0.11, P0.12.
**Goal:** ≤16ms slider tick on the reference scene set; full-res refine cancellable mid-flight.
**Content:**
- P0.5: `targetSize` parameter through `raw-pipeline.worker.ts` + WASM entry; fast ~2MP phase, 150ms-debounced full-res refine.
- P0.6: Web GPU pipeline — WebGL2 float shaders mirroring the Rust reference; coefficients generated via codegen (hook to CI.2 in phase I).
- P0.7: Tiled full-res refine, cancellable. Apple: verify CoreImage auto-tile on reference set. Web: manual tile dispatch.
- P0.10: Audit Web decoded-scene-linear buffer reuse across slider ticks; fix any reallocations.
- P0.11: Neighbor prefetch in filmstrip/grid (both shells).
- P0.12: Enable `wasm-bindgen-rayon` threading; fix bundler to serve `workerHelpers.js` with correct MIME + COOP/COEP headers in dev + prod.
**Size:** L. Likely split into C1 (two-phase + GPU + buffer reuse) and C2 (tiled refine + prefetch + threading) at plan-write time.
**Depends on:** A (proof), B (shared preview infra for the non-refine case).
**Plan file (to write):** `2026-04-27-phase-c-slider-latency.md`
**Acceptance:** Phase-A markers show ≤16ms slider-tick median, ≤50ms p99, refine cancellation observed on mid-flight tick, thread pool active under `coi-serviceworker` or real headers.

---

## Phase D — Decoded-image tile cache (`.maple/`)

**Backlog items:** TILE.1–TILE.7.
**Goal:** Co-located, versioned, platform-agnostic tile cache that survives app restart and (on cloud-backed sources) syncs across devices.
**Content:**
- TILE.1: `raw-core` pyramid writer + tile encoder (512×512, u16 linear RGBA, zstd). Atomic-rename writes (no torn files).
- TILE.2: Apple `TileStore` protocol + `CoLocatedTileStore` (`.maple/`), `iCloudTileStore` (PhotoKit shared container), `NullTileStore` (read-only sources).
- TILE.3: Self-Hosted API `GET /tiles/<asset-id>/<version>/<level>/<x>_<y>` reading from server-side `.maple/`.
- TILE.4: Web `TileStore` with `ApiTileStore` (Self-Hosted) + `CoLocatedFSATileStore` (File System Access writable dir). Single-file openers: memory-only.
- TILE.5: Parity test — tiles byte-identical Rust-native vs Rust-WASM for the full reference scene set.
- TILE.6: `.gitignore` + docs note on `.maple/`.
- TILE.7: Source write-capability probe + read-only UI state (disabled develop panel). Enforces read-only product invariant.
**Size:** L.
**Depends on:** none functionally, but best after C so the cache accelerates a pipeline that's already fast.
**Plan file (to write):** `2026-04-28-phase-d-tile-cache.md`
**Acceptance:** parity test green; second-open of a reference scene reads tiles from disk and skips demosaic; read-only source probe disables develop panel in UI.

---

## Phase E — Color science uplift (core-only)

**Backlog items:** COLOR.1–COLOR.5.
**Goal:** Move measured ΔE down on the reference scene set.
**Content:**
- COLOR.1: AMaZE demosaic (port from reference). Parity-gated.
- COLOR.2: HA highlight-aware demosaic fallback.
- COLOR.3: DCP profiles + DNG color-spec parsing.
- COLOR.4: Capture sharpening stage.
- COLOR.5: Ratchet parity budgets down after the uplift (commit the new lower budget).
**Size:** M. Core-only; no shell work.
**Depends on:** none — runnable in parallel with B/C.
**Plan file (to write):** `2026-04-29-phase-e-color-uplift.md`
**Acceptance:** `src/scripts/test_color_pipeline.sh` passes under ratcheted budget; codegen artefacts updated.

---

## Phase F — Crop & rotate

**Backlog items:** FEAT.1.
**Goal:** Non-destructive crop + straighten as a first-class stage.
**Content:** raw-core stage (before view transform; output dims change); adjustment model (`Crop { rect, rotation_deg }`); Apple overlay (drag handles + aspect presets); Web overlay; XMP schema extension (versioned, passthrough-preserving); parity test.
**Size:** L.
**Plan file (to write):** `2026-04-30-phase-f-crop-rotate.md`

## Phase G — Tone curves

**Backlog items:** FEAT.2.
**Goal:** RGB-composite + per-channel tone curves.
**Content:** raw-core curve stage (monotone cubic, pre-AgX); curve editor in each shell (both input+output anchors + interactive drag); XMP schema; parity test.
**Size:** L.
**Plan file (to write):** `2026-05-01-phase-g-tone-curves.md`

## Phase H — Lens / perspective correction

**Backlog items:** FEAT.3.
**Goal:** Distortion + vignetting + perspective correction.
**Content:** raw-core stage (remap + devignette + homography); profile lookup (DNG opcodes + Lensfun for non-DNG); UI controls; XMP schema; parity test.
**Size:** L.
**Plan file (to write):** `2026-05-02-phase-h-lens-correction.md`

> **F/G/H are structurally identical** (core stage + XMP schema + both shells + parity). They can run as parallel sub-agent tracks after phase C lands. Each gets its own plan written just-in-time.

---

## Phase I — Parity catch-up + CI plumbing

**Backlog items:** PARITY.1, PARITY.3, CI.1, CI.2.
**Goal:** Close remaining Apple↔Web visible gaps + keep CI gates honest as new stages land.
**Content:**
- PARITY.1: Scopes (histogram + waveform) component on Apple, matching Web.
- PARITY.3: Self-Hosted source on Web (QR pairing or creds; reuse `bun-api-backend.service.ts`).
- CI.1: Parity CI gate extended to new stages (crop, tone curves, lens) — one budget row per stage.
- CI.2: Codegen coverage for new constants introduced by E/F/G/H.
**Size:** M.
**Depends on:** the stages they gate (at minimum: E for codegen; F/G/H for parity rows). Practical sequencing: write CI.1 and CI.2 as part of each feature phase, land PARITY.1 + PARITY.3 as a standalone plan after C.
**Plan file (to write):** `2026-05-03-phase-i-parity-plumbing.md`

---

## Phase J — Masking primitives + ROI refresh

**Backlog items:** LOCAL.1, P0.8.
**Goal:** Radial, linear, brush masks (+ subject/sky if in scope), plus ROI-only refresh to keep slider budget intact.
**Content:**
- LOCAL.1: Mask data model (union of primitives), UI for each mask type, feathering, invert, mask display mode. XMP schema for masks.
- P0.8: Region-of-interest refresh — re-render only mask bbox during slider ticks affecting that mask. Folds here because the bbox is the mask's.
**Size:** XL. Probably split at plan-write time into J1 (radial+linear), J2 (brush), J3 (subject/sky if shipping), J4 (ROI refresh).
**Depends on:** C (slider) and D (tile cache — tiles keyed so mask-scoped invalidation is cheap).
**Plan file (to write):** `2026-05-04-phase-j-masking.md`

## Phase K — Local adjustments

**Backlog items:** LOCAL.2.
**Goal:** Apply existing adjustment stack per mask.
**Content:** render graph change — adjustment nodes become mask-scoped; UI binds sliders to the active mask; XMP schema extension for per-mask adjustments.
**Size:** L.
**Depends on:** J.
**Plan file (to write):** `2026-05-05-phase-k-local-adjustments.md`

## Phase L — Healing / clone stamp

**Backlog items:** LOCAL.3.
**Goal:** Content-aware heal + straight clone.
**Content:** raw-core patch-match (or equivalent) stage; UI for source/destination spots; persisted heal records in XMP.
**Size:** L.
**Depends on:** J (uses masking primitive).
**Plan file (to write):** `2026-05-06-phase-l-healing.md`

---

## Recommended order of plan writing

1. **Phase A (instrumentation)** — required before any perf claim. Start here.
2. **Phase E (color uplift)** — parallel track; unblocks ΔE ratchet independently of UI work.
3. **Phase B (cold-open)** — proves first visible win.
4. **Phase C (slider)** — biggest user-felt perf improvement.
5. **Phase D (tile cache)** — amortizes C's wins across sessions.
6. **Phase F / G / H (features)** — parallel sub-agent tracks after C.
7. **Phase I (parity + CI)** — lands alongside F/G/H.
8. **Phase J → K → L (local edits)** — serial at the end; largest scope.

## What this roadmap explicitly does NOT do

- It does not write any implementation code.
- It does not commit to budgets beyond the invariants already in `CLAUDE.md`. Budgets for new stages are set per-plan, at write time, from a measurement on the reference scene set.
- It does not decide between WebGL2 vs WebGPU for phase C. That decision belongs in phase C's plan (default: WebGL2 per `docs/spec/00-overview.md`, revisit if Safari support lands before phase C starts).
- It does not choose subject/sky-mask vendor/implementation for phase J. That decision belongs in J's plan.

## Next action

Pick the next phase to plan in detail. Recommended: **Phase A**. Its plan will follow `superpowers:writing-plans` (TDD steps, exact paths, full code per step, commit after each task), saved as `docs/superpowers/plans/2026-04-25-phase-a-perf-instrumentation.md`.
