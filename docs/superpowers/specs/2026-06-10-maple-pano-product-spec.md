# Maple Pano — Panorama Stitching Product Spec

**Status:** Draft v1
**Companions:** `2026-06-10-maple-pano-stitching-spec.md` (pipeline tech spec — algorithm source of truth) · `2026-06-10-maple-pano-eng-design-spec.md` (engineering design)
**Component:** Maple Pano, surfaced in the host apps (Aperture, RedSunsetMaple — names per the stitching spec)
**Author:** Zubair Lawrence
**Date:** 2026-06-10

---

## 1. Summary

One-action panorama merge for RAW shooters. The user selects the frames of a pano set, hits **Merge to Panorama**, and gets back a geometrically correct, seam-free panorama as a **linear DNG** that lands in their library and edits exactly like a camera original — full white-balance, exposure, and color latitude, nothing baked in. Replaces the current stitcher (Maple PR #17), whose results are not shippable.

## 2. Problem

The current stitcher produces panoramas a working photographer won't keep: strips drift and bow across their length, wide panos stretch grotesquely at the ends, and seams show exposure steps and ghosting at 100%. The result reads as "broken," and because Maple's brand promise is _color and geometry you can trust_, a bad pano poisons trust in the whole editor.

**Who hits this:**

- **Drone photographers** — DJI pano modes capture the frames automatically (sphere, 180°, wide); the camera roll fills with 9–36 frame sets that _expect_ to be merged. This is the highest-volume, highest-expectation segment, and panos routinely exceed 180° FOV — exactly where the current approach is geometrically impossible.
- **iPhone ProRAW shooters** — handheld pivot sweeps, 3–10 frames.
- **Landscape/architecture photographers** — tripod or handheld multi-row sets where 100%-zoom seam quality is the bar.

**Cost of not solving:** users round-trip to PTGui / Lightroom / Hugin, which breaks the non-destructive RAW workflow (those tools emit tone-baked TIFF/JPEG or keep the user in another ecosystem). Pano merge is table-stakes for the drone segment; shipping a bad one is worse than shipping none.

## 3. Target users & jobs

| Persona                    | Job to be done                                                                                                                                             |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Drone shooter              | "Merge the pano set the drone just captured into one wide image I can edit like any RAW — without a desktop tool."                                         |
| ProRAW handheld shooter    | "Stitch my pivot sweep on the device I shot it on, and don't punish me for small hand wobble."                                                             |
| Landscape/architecture pro | "Give me a stitch I can print: no visible seams at 100%, level horizon, no bent verticals — and tell me when a frame didn't make it instead of hiding it." |

## 4. Product principles

Inherited from the house invariants; the pipeline is designed around them.

1. **Non-destructive.** Source frames are never modified. The panorama is a _new_ file; its own edits go to its own sidecar like any other image.
2. **Scene-referred output.** The deliverable is a linear DNG with no tone mapping inside. The pano enters the editor with the same latitude as a camera original. Display-referred output (HEIF/JPEG preview) exists only at the export boundary, through the house view transform.
3. **On-device.** No server round-trips, no upload of user photos.
4. **Honest failure.** When the stitcher can't do something well, it says so in plain language and degrades visibly, never silently. Misaligned frames are dropped and reported — never blended in crooked.
5. **Bounded waits.** Stitching is a batch job, not a live preview — but it shows staged progress, stays cancellable, and completes within the published time budgets.

## 5. Goals (v1 outcomes)

1. **Geometrically correct panoramas up to full 360°×180°** from DJI drone DNG and iPhone ProRAW input — no drift, bow, or end-stretch. Measured: synthetic-set rotation recovery within 0.1° of ground truth; loop-closure error ≤ 2 px on full 360° sets; horizon level within 0.3° on gimbal sets.
2. **Seam-invisible results on static scenes at 100% zoom**; bounded, seam-routed ghosting on scenes with motion. Measured: seam-line gradient-energy metric + reviewer pass on the regression corpus.
3. **Output that behaves like a camera original.** Linear DNG, ≥ 16-bit effective precision, recognized and editable in Maple, Apple Photos, Lightroom, and Capture One. 360° outputs recognized as spherical (GPano) by Photos/Files/Google viewers.
4. **Fast enough to feel native:** 6× 24 MP DNG → 120 MP pano in < 12 s on an M-series Mac, < 30 s on iPhone 15 Pro.
5. **Identical results everywhere.** Same input + settings → same pixels (within f32 tolerance) on macOS, iOS, and the web app.

## 6. Non-goals (v1)

- **Bayer-mosaic-level stitching.** We demosaic first and stitch in linear RGB. Mosaic-level alignment is a research problem with negligible quality upside over linear DNG output.
- **Full 3D reconstruction / translation rescue.** The pipeline assumes near-pure rotation (gimbal pano, handheld pivot). Walking-while-shooting input is detected and warned about ("pivot in place for best results"), not solved. AliceVision-class SfM is a different product.
- **Live/video or real-time preview stitching.** Batch only in v1; a fast low-res preview is a P1 follow-up.
- **Generative fill of sky/nadir holes.** Possibly a later opt-in "rescue" mode; never default, never v1.
- **Manual control-point editing.** _(Product addition, not from the tech spec.)_ v1 is fully automatic with actionable notices; a PTGui-style correspondence editor is out of scope and would signal the automation failed.

## 7. User stories

**Drone shooter**

1. As a drone shooter, I want to select a pano set in the grid and merge it in one action, so the set the drone captured becomes one editable image without leaving the app.
2. As a drone shooter, I want a full 360° sphere to merge without a visible "zipper" where the loop closes, so I can publish it as an interactive sphere (and have Photos/Google recognize it as one).
3. As a drone shooter whose AE was locked, I want the merged result to be seamless in exposure; and when I shot auto-exposure, I want the stitcher to equalize frames and tell me if the spread was extreme.

**Handheld / ProRAW shooter**

4. As a handheld shooter, I want small hand wobble absorbed by the alignment, so my no-tripod sweep still merges cleanly.
5. As a handheld shooter who walked sideways while panning, I want the app to tell me _why_ the result has artifacts and how to shoot better next time, rather than failing opaquely.

**Landscape / architecture pro**

6. As a pro, I want the panorama delivered as a linear DNG so I can white-balance, recover highlights, and grade it with the full RAW toolset — not a baked TIFF.
7. As a pro, I want the horizon level and verticals straight without manual correction, so the stitch is print-ready geometry out of the box.
8. As a pro, I want to know exactly which frames were left out and why ("2 photos couldn't be matched"), so I can decide whether to re-shoot or accept the crop.

**Edge / failure stories**

9. As any user, when one frame is sky-only and matches nothing, I want the stitcher to place it from the drone's gimbal data and flag it, rather than aborting the whole pano.
10. As any user, I want to cancel a long stitch mid-way with nothing written and the app fully responsive afterwards.

## 8. UX flow

### 8.1 Entry

- In **Browse** (grid), the user multi-selects 2+ frames → context/toolbar action **Merge to Panorama**.
- No hard frame-count cap in v1. Time/memory budgets are defined for the 6-frame reference job; large gimbal sets (~30 frames) must complete within proportionally scaled budgets; the solver is sized for sets up to ~150 frames.
- Mixed-source selections (different cameras/focal lengths) are accepted — the solver handles per-image focal fallback automatically; no user-facing lens settings.

### 8.2 Progress

A staged, cancellable progress surface. Stage names are user-language, mapped from pipeline stages:

| UI stage          | Pipeline stages underneath                               |
| ----------------- | -------------------------------------------------------- |
| Analyzing photos… | decode, demosaic, features, matching                     |
| Aligning…         | rotation estimation, bundle adjustment, horizon leveling |
| Compositing…      | gain compensation, warp, seam finding, blending          |
| Saving…           | linear DNG write, preview/export                         |

Cancel is available throughout; cancelling discards all partial work and modifies nothing.

### 8.3 Result + notices

On completion the user sees the panorama preview plus zero or more **plain-language, actionable notices** (decision §9.4 of the tech spec: actionable notices in UI, numbers in the debug log):

| Condition (detected by pipeline)                            | Notice copy                                                                                              |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Frames dropped (disconnected / high residual / low overlap) | "2 photos couldn't be matched and were left out."                                                        |
| Motion in overlaps (seam routed around)                     | "Movement detected, some areas may show ghosting."                                                       |
| Translation-dominant capture (parallax)                     | "Sideways motion detected; pivot in place for best results."                                             |
| Auto-exposure spread > 2 EV                                 | _(proposed copy)_ "Exposure varied widely between shots; brightness was equalized."                      |
| Low-texture frame placed from gimbal data                   | _(proposed copy)_ "1 photo had too little detail to match and was placed using the drone's camera data." |

Reprojection errors, per-camera poses, and solver diagnostics go to a debug log / hidden inspector — never to the primary UI. (Placement of notices — toast vs. result-sheet banner — is open question §9a.1 of the tech spec; resolve during the platform-integration build step.)

The result view offers a **projection override** (Auto → rectilinear / cylindrical / spherical) since auto-selection by angular extent is a heuristic; changing it re-renders without re-solving alignment.

### 8.4 Output

- **Primary:** linear DNG written alongside the source frames, named after the first frame (e.g. `DJI_0421-Pano.dng`; exact naming/stacking is an open question). It appears in the grid, opens in the editor, and edits like any RAW; its edits persist to its own sidecar.
- 360°×180° outputs carry GPano metadata so external viewers treat them as spheres.
- **Export options** (via the standard export flow): 16-bit TIFF (linear or display transfer); HEIF/JPEG preview through the house view transform; **f16 HDR DNG as an explicit opt-in** carrying a compatibility warning (copy informed by the reader-compatibility survey, tech spec decision §9.3).
- Source frames are untouched, byte-for-byte.

## 9. Requirements

### P0 — must ship

| #     | Requirement                                                                               | Acceptance criteria                                                                                                                                                                    |
| ----- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0-1  | Multi-select → Merge to Panorama entry point in Browse                                    | Given 2+ selected frames, the action is offered; given 1 frame, it is not.                                                                                                             |
| P0-2  | Rotation-model alignment with global bundle adjustment                                    | Mean reprojection error ≤ 1.5 px, max ≤ 6 px on the regression corpus; synthetic-set rotations within 0.1° of ground truth.                                                            |
| P0-3  | Frames that fail the alignment gate are dropped and reported, never composited misaligned | Forced-failure fixture produces a result without the bad frame + the "couldn't be matched" notice; no silent degradation.                                                              |
| P0-4  | Automatic projection by angular extent + user override                                    | < 60° → rectilinear, 60–130° → cylindrical, > 130° → spherical; override re-renders without re-solving.                                                                                |
| P0-5  | Exposure equalization in linear space                                                     | Locked-AE drone sets solve to ~unity gain; bracketed/auto-AE sets get correct relative scaling; > 2 EV spread triggers the notice.                                                     |
| P0-6  | Seam quality                                                                              | No visible seam at 100% on static-scene regression sets (seam-energy metric + review); motion routed around, not averaged into ghosts.                                                 |
| P0-7  | Level horizon                                                                             | Within 0.3° on gimbal-prior sets ("banana" artifact eliminated).                                                                                                                       |
| P0-8  | Loop closure                                                                              | ≤ 2 px closure error on full 360° sets.                                                                                                                                                |
| P0-9  | Linear DNG output                                                                         | ≥ 16-bit effective precision, no tone mapping; opens correctly in Maple, Apple Photos, Lightroom Classic, Capture One; embedded preview; stitch metadata in XMP; GPano on 360° output. |
| P0-10 | Performance                                                                               | 6× 24 MP → 120 MP: < 12 s M-series Mac, < 30 s iPhone 15 Pro; peak memory within the platform caps defined in the eng design.                                                          |
| P0-11 | Actionable notices                                                                        | Every §8 failure mode maps to exactly one plain-language notice; numbers live in the debug log only.                                                                                   |
| P0-12 | Cross-platform parity                                                                     | Identical output within f32 tolerance, Metal (macOS/iOS) vs. WebGPU (web), on the full regression corpus.                                                                              |
| P0-13 | Cancellable, non-destructive job                                                          | Cancel at any stage leaves the library byte-identical to before the action.                                                                                                            |

### P1 — fast follow

- **Low-res fast preview** before committing to the full-res stitch (tech spec §3 names this P1).
- **HDR bracket merge per position** feeding the stitcher (reuse the existing HDR merge ahead of this stage), for bracketed pano sets.
- **f16 HDR DNG export option** — ships when the reader-compatibility survey (tech spec decision §9.3) lands its warning copy; until then the option is hidden.
- **Debug inspector** surfacing per-camera poses and residuals (hidden-but-present vs. log-only is open question §9a.1).

### P2 — future considerations (design for, don't build)

- Generative fill "rescue" for sky/nadir holes — opt-in only, never default.
- Per-camera pose visualization as a debug view.
- Re-stitch from stored recipe: the output DNG already carries projection, FOV, and per-camera rotations in XMP — a later version can offer "re-stitch with different projection" without re-solving.
- Video / real-time stitching: explicitly out of scope; nothing in v1 should preclude a future preview-grade path.

## 10. Success metrics

Maple Pano runs on-device with no telemetry, so success is measured at the gate and through qualitative channels — not via in-product analytics.

**Leading (release gates, measured on the fixed regression corpus — these are the ship/no-ship signals):**

- 100% of §7 tech-spec acceptance gates green (reprojection, rotation recovery, seam energy, horizon, loop closure, perf, parity).
- Zero dropped frames across the curated "well-shot" corpus subset (drops should only occur on the deliberately-broken fixtures).
- Wall-time and peak-memory budgets met on reference hardware (M-series Mac, iPhone 15 Pro, Chrome/WebGPU).

**Lagging (post-ship, qualitative):**

- Stitching-related support tickets and community reports trend to zero "geometry/seam" complaints; remaining reports should be capture-technique cases that received the correct notice.
- Side-by-side corpus comparison vs. PTGui / Lightroom on the same sets documented and at-parity-or-better on seam and geometry metrics.
- Drone-community reviews cite pano merge as a reason to adopt, not a caveat.

## 11. Release phasing

| Phase                                   | Contents                                                                              | Maps to tech-spec build steps |
| --------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------- |
| **M0 — Harness**                        | Regression corpus + synthetic ground truth + CI gates. Nothing else lands without it. | Step 1                        |
| **M1 — Geometry core**                  | Match graph, rotation model, global BA, leveling. Gate: P0-2/3/7 metrics on corpus.   | Steps 2–4                     |
| **M2 — Compositing**                    | Projection, gain, GPU warp, graph-cut seams, multi-band blend. Gate: P0-4/5/6 + perf. | Steps 5–8                     |
| **M3 — Output & integration (v1 ship)** | Linear DNG writer, exports, notices UI, platform wiring, parity check. Gate: all P0.  | Steps 9–10                    |
| **v1.0 close-out**                      | Full regression run; delete the PR #17 path.                                          | Step 11                       |
| **v1.x**                                | P1 items (fast preview, HDR-merge input, f16 export, debug inspector).                | —                             |
| **v2 candidates**                       | P2 list.                                                                              | —                             |

## 12. Open questions

| #   | Question                                                                                                                                          | Owner          | Blocking?                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ----------------------------- |
| 1   | Notice placement: toast vs. result-sheet banner vs. both; debug inspector hidden-but-present vs. log-only. (= tech spec §9a.1)                    | Product/Design | No — resolve during M3        |
| 2   | Output file naming and library placement: sibling of sources? Stacked with sources in the grid?                                                   | Product        | No — needed by M3             |
| 3   | Where Merge to Panorama lives on phone-width layouts (single-column shell has no persistent multi-select toolbar).                                | Design         | No — needed by M3             |
| 4   | Is there any consented, privacy-compatible usage signal in the hosted web product worth defining, or do we stay fully measurement-free post-ship? | Product        | No                            |
| 5   | f16 HDR export warning copy — pending the reader-compatibility survey (tech spec decision §9.3, step 9).                                          | Eng → Product  | Blocks the P1 f16 option only |
