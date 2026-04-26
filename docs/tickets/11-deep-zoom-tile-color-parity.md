# Ticket 11 — Deep-zoom tile color parity

## Status

Open. Filed 2026-04-26. Gated behind `EditSession.deepZoomEnabled = false`
(commit `990a59f`) until this ticket lands.

## Symptom

The deep-zoom tile path renders 512² source-pixel tiles independently,
each running its own filter chain over the cropped sensor region (with
35 px overlap). Local-context stages — sharpen, clarity, NR luminance,
NR color — see different overlap context at tile boundaries:

- `nr_color` blurs in oklab; the blur kernel near the tile edge has
  truncated context, so two adjacent tiles produce slightly different
  chroma at the seam.
- `sharpen` (Richardson-Lucy 3-iter Gaussian PSF) reads ±radius
  context. The 35 px overlap covers some of this but not all kernel
  variants the user might pick.
- `clarity` and `texture` operate similarly.

User-visible result: faint color seams or per-tile contrast/sharpness
shifts at 100%+ zoom. Visible primarily on uniform regions (sky, walls,
out-of-focus background).

## Why it's gated

The user is shipping (or near-shipping) and the seams are unacceptable.
Whole-image sized-FFI refine produces pixel-perfect output — slower at
high zoom but correct. The flag stays at `false` (default off) until
this ticket closes.

## Path forward (sketch)

Three options, ranked by surgical-ness:

### A — Increase tile overlap

Bump `TILE_OVERLAP_PX` from 35 to whatever the worst-case stage radius
needs. Sharpen at radius 67 px is the high-water mark; matching that
plus a few px of slack (~75 px) would cover all current stages. Cost:
+25-30% extra sensor area per tile (overlap area / tile area). Risk:
might still be under for stage chains where one stage feeds another
(NR + sharpen).

### B — Per-stage radius-aware overlap

Rust-side: each filter stage knows its own radius, and the tile entry
pads the crop dynamically based on the active model. Mostly
mechanical — `pad_and_clamp_mosaic_rect` becomes
`pad_and_clamp_mosaic_rect_for_model(rect, model)` and computes max
radius from `model.sharpen_radius`, `model.nr_luminance`,
`model.nr_color`, `model.clarity`, `model.texture`. Avoids paying for
overlap when the user isn't using a particular stage.

### C — Tile-aware filter chain

Restructure local-context stages to read shared boundary buffers
between adjacent tiles. Considerable architectural surgery. Worth it
only if A+B prove insufficient.

## Acceptance

- A reference fixture rendered at 100% via deep-zoom matches the same
  fixture rendered via sized-FFI at native target. Numerically:
  mean ΔE ≤ 0.5, p95 ≤ 1.0 across the seam region.
- The acceptance test runs in `MapleCoreTests` so a regression trips
  CI.
- `EditSession.deepZoomEnabled` flips back to `true` once acceptance
  passes.

## Cross-links

- Commit `990a59f` (gate).
- `src/raw-pipeline/raw-core/src/pipeline.rs:570-720` (tile entry).
- `pipeline.rs:498-522` (`pad_and_clamp_mosaic_rect`).
- `TILE_OVERLAP_PX` constant.
- `Cache/TileManager.swift` for the Apple-side composite path.
- Audit fix D / Ticket 10 (`CanvasMath`) — adjacent canvas-math
  refactor that interacts with the deep-zoom routing path.
