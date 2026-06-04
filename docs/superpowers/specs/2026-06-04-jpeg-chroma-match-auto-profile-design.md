# JPEG chroma-match (Auto Profile chroma) — design

Tickets: to be opened on plan approval — a Files-board ticket for the raw-core chroma solver + inject, plus the existing GPU-wiring tickets **#812** (Apple Metal) and **#394** (web WebGL2), which Phase 2 extends. Originates from the "Hybrid Color Pipeline" RFC v2 (§3.2). Drafted 2026-06-04. **Feature 2 of two** (Feature 1 = the per-zone ΔE instrument + test_0003 diagnosis, PR #910).

This is a **design** spec — it defines the chroma solver, the inject point, the GPU story, the validation gate, and the phasing. It does not implement them.

---

## The load-bearing risk (read this first)

**The chroma fit must target the POST-AgX appearance, not pre-AgX a/b — or it reproduces, one layer up, the exact HSM sat-scale over-saturation Feature 1 just diagnosed.** Two facts force this:

1. AgX moves `a`/`b` (inset desaturation, path-to-white, Oklab gamut compression) **after** any pre-AgX transform. So fitting `pre-AgX RAW a/b → JPEG a/b` and applying it pre-AgX does **not** make the final (post-AgX) render match the JPEG — AgX shifts it afterward.
2. The "linearized JPEG" (inverse sRGB TRC) is **not** scene-referred — inverse-sRGB undoes the encoding, not the camera's tone curve. So the JPEG's `a`/`b` already carry the camera's **tone-induced** saturation. Inject those pre-AgX, then run AgX, and highlights **double-saturate** — the same collision as the Adobe HSM sat-scale under AgX (see `docs/superpowers/findings/2026-06-03-test_0003-baseline.md`). "Keep the RAW's L" does **not** protect against this: the collision is in `a`/`b`.

Therefore (corrected from the RFC's naive framing): **fit through AgX** — the solver minimizes the difference between the **post-AgX rendered** output and the JPEG, with AgX as a fixed forward model in the loss. The validated value-aware **highlight taper** (from the HSM work) is carried as the mitigation/safety-net, and the gate measures **post-AgX, per-tonal-zone, on held-out pixels** so a highlight over-saturation cannot hide behind a healthy global mean.

## Summary / load-bearing decisions (user-confirmed)

- **Extend Auto Profile, not a new mode.** `Profile::Auto` today fits a per-channel **tone** curve from the embedded JPEG (post-AgX, display space). It gains a **chroma** match: an image-specific transform of the OKLAB `a`/`b`, solved from the same JPEG, applied at decode (pre-AgX), **keeping the RAW's own L**. One coherent "match the camera JPEG" mode; reuses the JPEG extraction + LRU cache (#550).
- **Chroma is `a`/`b` only; AgX owns 100% of tone.** The transform never touches `L`.
- **Decode-stage, so it rides to the GPUs for free.** The transform is per-image and fixed, so it lives in the **shared** `develop_scene_linear` (post-DCP), reaching Apple Metal + Web WebGL via the same scene-linear buffer as the DCP/HSM — **no per-platform chroma shader**. The only new **GPU** work is wiring the Auto Profile **tone LUT** (post-AgX) into Metal (#812) + WebGL2 (#394), the existing gap.
- **Fit through AgX** (the load-bearing risk above), gate post-AgX/per-zone/held-out.

## Goals / non-goals

**Goals**

- A deterministic-per-image chroma transform whose **post-AgX** output moves toward the embedded JPEG, validated against the JPEG (not ACR), without over-saturating highlights.
- Chroma applied in the shared raw-core decode so it reaches Apple + Web with no new shader.
- The Auto Profile **tone LUT** wired into Metal (#812) + WebGL2 (#394), parity-gated (Phase 2, separate cycle).
- Reuse: JPEG extraction/orientation/LRU cache (#550); the per-hue/per-zone ΔE instrument (Feature 1) for the gate.

**Non-goals**

- Not a new user-facing look; extends `Profile::Auto`.
- Does not change `--profile neutral` — chroma only fires for `Profile::Auto`, so the ACR color-parity gate is unaffected.
- No full 3D chroma LUT (banding, RFC §3.2 Step 5).
- No `.maple`/XMP sidecar persistence — in-memory LRU only (inherit #550).
- Does not re-open tone formation (AgX + the existing post-AgX curve stay).

## Component 1 — the chroma solver (raw-core)

Reuses `view/auto_profile/preview.rs` (embedded-JPEG extract + EXIF orientation + downsample). Per RFC §3.2 Steps 1–5, **corrected for the fit domain**:

1. **Sample.** A uniform grid (≈64×64) from (a) the scene-linear matrix-applied RAW (Rec.2020, post-DCP, pre-AgX) downsampled to JPEG dims, and (b) the linearized JPEG.
2. **Common OKLAB — correct per-space path.** Convert both to the same absolute OKLAB through colorimetrically-correct paths (JPEG: `sRGB → linearize → Rec.2020 → rec2020_to_oklab`; RAW: `Rec.2020 → rec2020_to_oklab`). **Not** the RFC's "feed wide-gamut through the sRGB-OKLAB matrices."
3. **Filter** (new vs the tone path): drop JPEG-clipped pairs (`> 245` / `< 10`); drop high-3×3-variance pairs (block artifacts, CA, edges); **center-weight** the grid (the JPEG is vignette/distortion-corrected, the RAW is not — RFC's cheaper fallback to full vignette-correction).
4. **Solve — through AgX (the corrected objective).** Find the chroma transform `T` on `(a,b)` whose **post-AgX rendered** output best matches the JPEG, with AgX as a fixed forward model in the loss: minimize per-pixel ΔE between `AgX(inject(scene, T))` (display) and the JPEG (display) over the clean, center-weighted set. `T` is a low-degree **root-polynomial** on `(a,b)` (exposure-invariant, compact-to-cache, no 3D-LUT banding), solved by iterative least-squares (cheap — small parameter vector, once per image), **regularized toward identity** so sparse hues do not drift (this is the blue-overshoot guard). A **value-aware highlight taper** (the mitigation validated in the HSM work — attenuate `T` toward identity as scene value rises) bounds residual highlight over-saturation.
   - **Simpler alternative if the through-AgX solve proves heavy:** tone-normalize the JPEG first (apply the inverse of #550's estimated camera tone curve to bring the JPEG `a`/`b` toward scene-referred), then fit pre-AgX `a/b → tone-normalized-JPEG a/b` linearly. Approximate; same gate decides.
5. **Output.** A small coefficient block (the polynomial + taper params), cacheable, deterministic per image.

## Component 2 — inject at decode + chroma/tone consistency (raw-core)

**Inject point.** A new stage in `develop_scene_linear_from_raw_with_quality` (the **shared** scene-linear producer), right after `dcp::apply_colorimetry`, gated on `Profile::Auto`. Per pixel: `Rec.2020 → OKLAB → apply T to a,b only (keep L) → Rec.2020`. Because this is the shared decode that feeds Metal and WebGL, the chroma rides to all platforms with no GPU shader (as the DCP/HSM do).

**Consistency (chroma↔tone ordering).** Solve chroma first, apply it, then fit the post-AgX tone curve on the chroma-applied render so the two halves of `Profile::Auto` agree. **Note:** this ordering does **not** address the tone-collision risk above — that is a different axis (the collision is in `a`/`b` under AgX, fixed by the through-AgX fit objective, not by tone-after-chroma ordering).

**Fallback.** JPEG-extract failure or an ill-conditioned fit → identity chroma → the deterministic CM/FM+2D-HSM baseline (same robustness contract as #550's tone fallback).

## Component 3 — GPU: wire the Auto Profile tone LUT (Metal #812 + WebGL2 #394) — Phase 2, separate cycle

The chroma needs no GPU shader (Component 2). What is missing on the live paths is the Auto Profile **tone** LUT (post-AgX, display stage), which Metal/WebGL re-implement. So Phase 2: host (Swift / TS) bakes the per-channel tone LUT via `maple_compute_profile_lut` / WASM, uploads it as a GPU texture, samples it after AgX + Rec.2020→sRGB + gamma, before dither — matching the CPU tail in `pipeline/render/mod.rs`. One LUT per image (re-sampled per tick, re-baked only on image change). **Parity gate (the merge gate):** Apple + Web full renders (shared-decode chroma + GPU AgX + GPU tone LUT) match the Rust reference within budget.

**This is its own cycle, decomposed per platform.** Metal + GLSL + Swift/TS host + a two-platform parity gate is too large for one plan and **cannot be verified from raw-core** — it needs real Xcode/simulator and browser runs (see the device/sim constraints in project memory). The implementation plan written next covers **Phase 1 (raw-core) only**; Phase 2 gets an Apple plan and a Web plan in a later cycle.

## Validation

A **chroma-match gate, distinct from the ACR neutral gate**, designed so a highlight over-saturation cannot hide behind a global mean:

- **Post-AgX.** Render `Profile::Auto` (full pipeline, through AgX) and compare the **display output** to the JPEG — not the pre-AgX intermediate.
- **Per-tonal-zone, per-hue.** Use the Feature-1 instrument: highlight-zone `a`/`b` specifically (where the collision lands), plus per-hue `a`/`b` (where sparse-hue regularization fails — the blue-overshoot mechanism). A global a/b ΔE alone is **insufficient** (it hid the HSM over-saturation).
- **Held-out.** Fit `T` on a pixel subset, **measure on the rest** — catches the regularization failing in under-sampled hues rather than memorizing them.
- **Budget-ratcheted.** Plug into the existing `auto_profile_diff.py` / `test_auto_profile_match.sh` (which already gate the tone match) with committed per-zone budgets that ratchet down.
- **Edge-vs-center** ΔE confirms the lens-falloff handling (RFC §5).
- **Solver unit tests** (raw-core): a synthetic known shift is recovered through AgX; identity when JPEG ≈ render; regularization + taper keep sparse/highlight output near identity; clipped/high-variance pairs excluded.
- **No-regression:** `--profile neutral` ACR gate untouched. **Parity:** Rust ↔ Metal ↔ WebGL on `Profile::Auto` (Phase 2).

The target is the manufacturer JPEG, not ACR — "good" means "reproduces the camera's chroma without over-saturating," a deliberately different bar than the ACR gate.

## Phasing

- **Phase 1 (raw-core) — the plan written next covers only this.** Chroma solver (through-AgX objective) + decode-stage inject + chroma/tone consistency re-fit + the post-AgX/per-zone/held-out chroma-match gate + solver unit tests. Self-contained, CPU-validated via `maple-cli`; rides to Apple/Web via the shared buffer.
- **Phase 2 (GPU) — its own cycle, per platform.** Wire the Auto Profile tone LUT into Metal (#812) and WebGL2 (#394) + host integration + the parity gate. Requires Xcode/sim + browser runs.
- **(Phase 3, optional):** ColorChecker validation; escalate center-weighting to full RAW vignette-correction if edge-vs-center ΔE stays high.

## Relationship to existing work / build base

- **#550 Auto Profile (tone)** — extended, not replaced.
- **#812 / #394 (GPU Auto Profile wiring)** — completed for the tone LUT in Phase 2 (the "both" thread).
- **Feature 1 instrument (PR #910, unmerged)** — the chroma gate extends it. **Build base:** Phase 1 must branch off PR #910 (or off main after #910 merges), not bare main — bare main has no instrument to extend.
- **Deterministic baseline (CM/FM + 2D-HSM)** — the fallback when the JPEG fit is unavailable.
- **HSM productionization (#825, #828/#829)** — independent; orthogonal to the chroma match.

## Open questions / risks

- **Headline risk: the tone-collision** (above). Mitigated by the through-AgX fit objective + value-aware highlight taper + the post-AgX/per-zone/held-out gate. This is the make-or-break of the feature.
- **Through-AgX solve cost / convergence:** iterative least-squares with AgX in the loop, once per image — bound the iterations; fall back to the tone-normalized-JPEG linear fit if convergence is unreliable.
- **Polynomial degree + regularization + taper strength:** tune empirically against the per-zone gate; start low-degree.
- **Center-weighting vs full vignette-correction:** center-weighting chosen; escalate (Phase 3) if edge-vs-center ΔE stays high.
- **Validation reference is the JPEG, not ACR** — its own bar; do not regress it against the ACR neutral budgets.
- **Decode cost:** one OKLAB round-trip + a small polynomial per pixel at decode (once per image, not per tick) — negligible; no per-tick or per-WASM-boundary cost.
