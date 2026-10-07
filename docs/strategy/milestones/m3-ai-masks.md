# M3b — AI subject / sky masks (#361)

**Milestone 15 · Local Adjustments & Repair.** A slice of [m3-local-adjustments.md](m3-local-adjustments.md) (§3.6) and a sequel to [m3-skin-tone-vectorscope.md](m3-skin-tone-vectorscope.md), which delivered the subject half of this ticket's scope. Written 2026-10-06; it answers #361's three open questions — model choice, mask storage, latency budget — against the mask infrastructure that has merged since the ticket was filed, and specs the one selection that remains: sky.

## 1. Outcome

A photographer taps "Select Subject" or "Select Sky" on a mask layer and gets a one-shot AI selection they can grade with the same per-mask controls a gradient mask already has. The selection round-trips through the XMP sidecar as a recipe (never pixels), regenerates its raster on any device that can run the model, and never blocks the 16 ms slider tick.

When #361 was filed, none of that infrastructure existed. Today the subject half is fully shipped and only sky is open:

| Selection             | Apple                                                                                                 | Web                                                                                                                                        | Shared core                                                                                                        |
| --------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Subject (person/skin) | Vision person-instance + face rectangles, `PersonSkinMaskService` + `MaskRasterStore` (#3284, merged) | Server-side decision (#3300); client + IndexedDB cache (#4285, merged); person-segmentation stage + raster endpoints (#4284/#4343, merged) | `Mask::Bitmap` + raster registry + `crs:MaskGroupBasedCorrections` (#3282, merged); TS/WASM mirror (#3430, merged) |
| Sky                   | Nothing                                                                                               | Nothing                                                                                                                                    | Nothing — this doc specs it; the XMP shape ships in this doc's PR                                                  |

This document therefore does two things: it records the subject decisions by reference (they are settled and must not be re-litigated or duplicated here), and it makes the sky decisions concretely.

## 2. Decision 1 — model choice per platform

### 2.1 Subject: settled, referenced, not revisited

- **Apple** runs on-device Apple Vision: `VNGeneratePersonInstanceMaskRequest` for per-person instance masks plus `VNDetectFaceRectanglesRequest` to split facial-vs-body skin. Zero download, no provisioning, at the package's macOS 14 / iOS 17 floor. Model id `apple-vision-person-instance/1`. (PR #3284.)
- **Web** segments server-side: the Self-Hosted server detects people once per asset and serves rasters by digest. The in-browser model lost on M3 §7 grounds (multi-MB download plus per-device inference vs. segment-once-per-asset). (#3300 slice-3 decision, client #4285.)
- **Server** runs an ONNX model (`person_segmentation.onnx`, id `maple-server-person-instance/1`) behind a `defineStage()` stage depending on `thumb`/`preview`, `pausedOnFirstBoot`, model path in DB-backed settings. (#4284, landed #4343.)

### 2.2 Sky: a lightweight binary sky model on the two existing runtimes

Sky is the narrow, well-separated class M3 §3.6 already called out: it needs a cheap binary segmenter, not a general segmenter. No platform gets a new ML runtime:

- **Apple**: Vision ships no sky-segmentation request (person instance, face, and saliency only), so Apple sky runs a small binary sky-segmentation ONNX model through the ORT integration `maple-pano` already proves on both Apple targets — dynamic dylib on macOS, static on iOS (`ort` with/without `load-dynamic`), CoreML execution provider where available. The model ships with the app or downloads once on first use (implementation-time choice, following the `face-detect` SCRFD precedent); either way the recipe's `model` id versions it.
- **Server**: a sibling ONNX model file (`sky_segmentation.onnx`, id `maple-server-sky/1`) behind a `sky-segmentation` stage shaped exactly like `person-segmentation` (depends on `preview`, version-gated, `pausedOnFirstBoot`, DB-backed settings). One model per selection keeps versioning, digests, and cache retirement independent.
- **Web**: no in-browser model — same M3 §7 reasoning as subject. The web sky client fetches from the server exactly the way `SubjectMaskService` fetches persons.

The exact checkpoint (MobileNet/U-Net-class, ~1–2 MB, trained on sky labels) is picked at implementation time, the way #4284 scoped model selection inside the stage issue rather than in the design doc. What is fixed here is the contract around it: the model id rides the recipe (§3), and a model bump retires cached rasters because the digest folds the model id in (§5).

Explicitly out: a SAM-class click-anywhere segmenter (M3 non-goal, a future escalation for both #361 and #1472 Phase 4, not this slice), and depth-based anything (Maple has no depth source — M3 §7).

## 3. Decision 2 — mask storage: recipe in XMP, raster as a derivative

Of the ticket's three options — XMP bitmap reference + checksum, derived-on-demand, sidecar adjunct file — the merged subject work already picked the first, and sky reuses it unchanged:

- The sidecar stores the **recipe only**: `papp:MaskSource="Sky"` plus `papp:MaskModel` and `papp:MaskDigest` on a `crs:What="Mask/Image"` leaf inside `crs:MaskGroupBasedCorrections` (Lightroom 11+'s own AI-mask container). No person/skin attributes — a sky recipe is identified by model + digest alone. The Rust XMP shape ships in this doc's PR (§6); Swift/TypeScript already drop-and-passthrough unknown `papp:MaskSource` values, so a sky leaf opens losslessly on hosts that don't model it yet.
- The **raster is a content-addressed derivative**, never sidecar state: Apple under `.maple/masks/` (`MaskRasterStore` policy, 1024 px long edge PNG), web in IndexedDB, server in its stage cache. Missing raster regenerates from the recipe; failed generation is never cached, so the next call retries.
- A reference renderer sees a structurally valid `Mask/Image` leaf; Maple-private provenance stays in the `papp:` namespace, per M3 §8 decision 4.

Why not the other two: derived-on-demand with no cache would re-run inference on every open (seconds, not milliseconds, on both runtimes); an adjunct file next to the sidecar would need its own naming, cleanup, and sync story that the content-addressed cache already solves; and pixels in XMP would break the Adobe-readability requirement M3 §1 states outright.

## 4. Decision 3 — latency: detection is one-shot and never on the tick

The ticket's constraint stands as stated — subject/sky detection must not block the 16 ms slider tick — and the shipped subject flow already proves the shape sky copies:

1. Detection runs **once per user gesture** (tap "detect"), off the render path, with progress UI. Its budget is interactive-scale (sub-second target), not frame-scale.
2. The resulting raster **registers** into the process-wide registry (`maple_mask_raster_register` / `registerMaskRaster`) before the next render. Registration is the only handoff the tick sees.
3. Until a raster resolves, a bitmap layer evaluates to **weight 0** — never a global correction, never a stall. Every host already implements this: unresolved `raster_id` plus digest-miss reads as 0 in `mask::evaluate`, and the web client renders the layer at weight 0 with an honest "unavailable" message when the server 404s.

No new per-tick allocation, no new FFI tail field (the flat wire already carries `raster_id`), no WASM round-trip per slider move. The GPU kernel reads the registered raster like any other bitmap layer.

## 5. Normative contracts (fixed by this doc)

**XMP** (`docs/xmp-canonical-format.md`, "Bitmap and Everywhere masks"):

```xml
<rdf:li
  crs:What="Mask/Image"
  crs:MaskSubType="1"
  crs:MaskValue="1"
  papp:MaskSource="Sky"
  papp:MaskModel="maple-server-sky/1"
  papp:MaskDigest="0011223344556677"/>
```

`papp:MaskDigest` is required (hard parse error in `raw-core`, drop-the-correction in Swift/TypeScript/C#, same as `PersonSkin`). `papp:MaskModel` defaults to empty. Person/skin attributes are ignored on a Sky leaf when present.

**Digest scheme** (shared by Apple, web, and server — all three must agree, extending the #4284 contract): FNV-1a 64-bit over the UTF-8 of `{assetKey}|sky|{model}`, 16 lowercase hex. Same hash, same hex encoding, same model-folding as the person scheme (`{assetKey}|{person}|{facialSkin}|{bodySkin}|{model}`); the literal `sky` segment keeps the namespaces disjoint so a sky digest can never collide with a person digest for the same asset and model family.

**Server endpoints** (for the sky-stage follow-up, mirroring #4284): `GET /api/sky-masks?asset=<urlencoded assetKey>` → `{ model, sky: { bbox } }` (bbox optional; absent means whole-frame candidate), 404 when the stage hasn't run; rasters served by the existing digest-addressed raster endpoint, which is model-agnostic by construction.

## 6. What this PR implements (slice 0: the XMP shape)

Following the #3300 slice-1/2 precedent (wire + registry first, producers later), this doc's PR lands the core half only:

- `MaskSource::{PersonSkin, Sky}` + `BitmapRecipe.source` (`raw-core`), defaulting to `PersonSkin` so every existing construction is unchanged. Evaluation and the flat wire are source-agnostic (raster-id lookup, unresolved → weight 0), so no stage, kernel, or FFI change.
- `papp:MaskSource="Sky"` serialize + parse with the §5 contract, golden-tested round-trip, missing-digest hard error, and person/skin-attribute tolerance tests.
- This doc, the `docs/README.md` index row, and the `docs/xmp-canonical-format.md` Sky paragraph.

## 7. Implementation remainder (follow-ups, not this PR)

1. **Apple sky producer**: sky ONNX model + ORT session (pano-crate precedent), `MaskRasterStore` registration, people-picker-style "Select Sky" UI. Needs a model id (e.g. `apple-ort-sky/1`) and the §5 digest in `EditSession`.
2. **Server sky stage**: `sky-segmentation` `defineStage()` stage + `GET /api/sky-masks` endpoint (raster endpoint reused). Model selection inside the stage issue, per #4284's precedent.
3. **Web sky client**: `SubjectMaskService`-shaped fetch + IndexedDB cache + register flow against the §5 digest, plus the Detect-button UI. Self Hosted only, same gating as persons.
4. **Swift/TS `Sky` model mirrors**: parse `papp:MaskSource="Sky"` into the host recipe type (until then: drop-and-passthrough, lossless).
5. **Parity fixture**: a masked-sky manifest case with an ACR reference + `budgets.json` entry, gated by `test_color_pipeline.sh` — needs #358's writer lineage the way #1478 does, and a reference renderer that understands Sky selections.

## 8. Acceptance tests

- The §6 XMP tests (in this PR).
- Per producer slice: a committed-fixture test proving detect → raster → register → weight on that host, mirroring `PersonSkinMaskServiceTests` (Apple) and the `SubjectMaskService` suites (web).
- The §7.5 parity fixture, budgets ceilinged 5–10% above measured per the standard harness workflow.
- Budgets never widen: no slice in §7 touches `test-fixtures/budgets.json` except to add the new fixture's entry.

## 9. Non-goals

- No SAM-class general segmentation; no depth masks; no in-browser model (all M3 §7).
- No Windows masking UI (M3 §7 — no ticket, and Windows lacks develop copy/paste).
- No zoomed/tiled mask editing — `pipeline::tile` keeps rejecting local adjustments for M3.
- No change to the shipped subject path: this doc references #3284/#3300/#4284/#4285/#4343 and duplicates none of them.
