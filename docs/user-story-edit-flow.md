# User Story — Open, Adjust, Export

**Status:** Draft
**Owner:** Zubair
**Last updated:** 2026-04-27
**Related:** `docs/maple-prd.md`, `docs/photo-app-feature-spec.md`, `docs/photo-app-ui-spec.md`

---

## Primary user story

> **As a** working photographer,
> **I want** to open a RAW file, move any adjustment slider and see the preview update in real time, and export the result in a color that matches what I just saw on screen,
> **so that** I can trust Maple end-to-end and finish edits in the same flow I started them — without waiting on previews, second-guessing the color, or re-rendering to check.

This single story is the load-bearing flow for Maple. If it breaks, neither pillar holds; if it works, the product earns trust on contact. It exercises both pillars simultaneously: **performance that disappears** (between input and preview) and **professional color quality** (between preview and export).

---

## Sub-stories

Decomposed into the three beats of the flow. Each is independently testable.

### 1. Open the image

> **As a** working photographer,
> **I want** to open a RAW file from a folder I selected and see a correct, color-accurate preview within one frame on a cache hit (and within a second on a cold open),
> **so that** I can start editing immediately rather than waiting on the editor.

### 2. Adjust in real time

> **As a** working photographer,
> **I want** every adjustment slider — exposure, white balance, contrast, highlights, shadows, presence, color, HSL, curves, sharpening, NR — to produce a new on-screen preview inside a single 60Hz frame as I drag,
> **so that** my eye and my hand stay in the same loop and I can land an edit by feel, not by waiting.

### 3. Export with expected color

> **As a** working photographer,
> **I want** the exported JPEG, HEIC, or TIFF to be pixel-identical (within ΔE₀₀ ≤ 1) to the on-screen preview I approved at the moment of export,
> **so that** what I delivered to the client is what I saw, with no surprises after the fact.

---

## Acceptance criteria

### Open the image

- [ ] **Given** the user has selected a folder containing a supported RAW file (`.dng`, `.cr3`, `.arw`, `.nef`, `.raf`, `.heic`, `.jpg`)
      **When** they double-click the thumbnail in the grid (or hit ↵)
      **Then** Maple enters Full image mode and the canvas displays the rendered preview within one frame (~35ms p50) **if the rendered-preview cache hits**.
- [ ] **Given** the same action **and** a cache miss
      **When** the canvas opens
      **Then** the fast-phase preview (viewport resolution, screen-res) lands within 250ms p50 / 1000ms p95, with a visible progress affordance, and the refine-phase (full resolution) follows within the next 150–500ms.
- [ ] **Given** the image is opened
      **When** any sidecar `.xmp` exists alongside the RAW
      **Then** the preview reflects the sidecar's adjustments at first paint — never an unedited starting point that briefly flips to the edited state.
- [ ] **Given** the image fails to decode (corrupt, unsupported, locked)
      **When** the user opens it
      **Then** Maple shows a specific error in the canvas with the file path and a reason, **without** crashing, beachballing, or modifying the original.
- [ ] **Negative case:** at no point during open is the original file's bytes modified. CI export-path test verifies SHA-256 unchanged.

### Adjust in real time

- [ ] **Given** the canvas shows a 100MP reference RAW
      **When** the user drags any slider continuously
      **Then** each tick produces a new preview frame at p50 ≤ 16ms, p95 ≤ 35ms, p99 ≤ 50ms on supported hardware, with no frame drops visible to the user.
- [ ] **Given** the user releases the slider
      **When** the 150ms debounce window elapses
      **Then** a refine pass renders at full image resolution and lands in the canvas, replacing the fast-phase preview without a visible "flash" or color shift.
- [ ] **Given** the user moves a different slider before the refine pass completes
      **When** the new tick arrives
      **Then** the in-flight refine pass is cancelled cleanly (no allocations leaked, no stale frame painted) and the new fast phase resumes.
- [ ] **Given** any slider tick
      **When** the render scheduler runs
      **Then** zero allocations occur on the hot path and zero round-trips cross the WASM boundary per tick (web). Verified by perf harness on every merge.
- [ ] **Given** an adjustment has been made
      **When** the user inspects the sidecar
      **Then** the change is persisted to the `.xmp` within ≤ 250ms of the slider release; unknown XMP fields from other editors are preserved byte-for-byte.
- [ ] **Negative case:** moving any slider never modifies the original RAW's bytes. CI verifies SHA-256 unchanged after a 30-tick fuzz of every adjustment.

### Export with expected color

- [ ] **Given** the canvas shows the user's approved edit
      **When** they invoke Export → JPEG (or HEIC, TIFF)
      **Then** the exported file's pixels match the on-screen preview at p50 ΔE₀₀ ≤ 1 mean across the image, with the export ICC-tagged as the chosen output color space (sRGB / Display P3 / Adobe RGB / ProPhoto).
- [ ] **Given** the export
      **When** Maple writes the file
      **Then** EXIF metadata is preserved (camera make/model, lens, exposure triplet, GPS if present), the XMP sidecar's adjustment summary is embedded as a metadata block, and the file size matches the requested quality setting within ±10%.
- [ ] **Given** the same RAW + sidecar opened on macOS, iOS, iPadOS, and the web
      **When** each platform exports the image
      **Then** the four outputs are pixel-identical to mean ΔE₀₀ ≤ 1 against each other (cross-platform parity gate).
- [ ] **Given** the disk fills mid-export
      **When** the write fails
      **Then** Maple surfaces a recoverable error with a retry/relocate option, **without** leaving a partial / corrupted output on disk.
- [ ] **Given** the export completes
      **When** the user re-opens the original RAW
      **Then** the preview is identical to what they saw at the moment of export — the sidecar fully captures the edit state.
- [ ] **Negative case:** the original RAW's bytes are unchanged after export. SHA-256 verified by CI on every export-path test.

---

## End-to-end happy path (Given / When / Then)

- **Given** Zubair opens Maple, picks the folder containing `dji-mavic3pro-100mp.dng`, and double-clicks the thumbnail
- **When** he drags the Exposure slider from 0.0 to +0.7, then Highlights from 0 to −40, then Vibrance from 0 to +15
- **Then** each slider tick paints a new preview within one 60Hz frame, the refine pass lands within ~200ms of release, the `.xmp` sidecar reflects the three adjustments, and the original `.dng` bytes are unchanged
- **And when** he chooses Export → JPEG (Display P3, quality 90)
- **Then** the resulting JPEG is ICC-tagged Display P3, matches the on-screen preview at mean ΔE₀₀ ≤ 1, preserves EXIF, and lands on disk within ≤ 5 seconds p50

---

## Mapping to product pillars

| Beat              | Pillar 1: Color                                              | Pillar 2: Performance                                                |
| ----------------- | ------------------------------------------------------------ | -------------------------------------------------------------------- |
| Open              | Sidecar-driven first paint — no unedited flash               | Cache hit ≤ one frame; cold open ≤ 1s p95                            |
| Adjust            | Scene-referred pipeline; no clipping before view transform   | Slider tick ≤ 16ms / 50ms; zero hot-path allocs; cancellable refine  |
| Export            | ΔE₀₀ ≤ 1 preview-to-export; cross-platform parity ΔE₀₀ ≤ 1   | Export under the user's patience threshold; non-blocking UI          |

If any cell in this matrix regresses, the story breaks. The harnesses (`test_color_pipeline.sh`, `SliderMatrixUITests`, the parity gate) exist to keep them green on every merge.

---

## Definition of done

The story is "done" when, on a clean install on supported hardware:

1. All acceptance criteria above pass on the reference scene set.
2. The color harness reports mean ΔE₀₀ ≤ 5 (target) against ACR ground truth on the public reference fixtures.
3. The slider-matrix harness reports p50 ≤ 16ms, p99 ≤ 50ms across every adjustment slider on a 100MP RAW.
4. The cross-platform parity harness reports mean ΔE₀₀ ≤ 1 between Apple and Web exports of the same RAW + sidecar.
5. The originals-untouched hash check passes across the full export path.
6. A working photographer (design partner, not staff) can complete the happy path on first contact without instruction.
