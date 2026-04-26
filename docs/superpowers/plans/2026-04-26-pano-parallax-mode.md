# Pano P6 — Parallax mode (placeholder plan)

> **Status:** Placeholder created 2026-04-26 to satisfy
> [`docs/tasks/04-maple-panorama-spec.md`](../../tasks/04-maple-panorama-spec.md)
> task **T6.1**. Expand into a full execution plan when MVP (P1–P5)
> ships and a parallax-heavy fixture corpus exists.

## Scope (when expanded)

Per [spec § 11 P6](../../tickets/04-maple-panorama-spec.md):

- UDIS++ TPS warp + composition mask, behind `ml-udis` Cargo
  feature. **Research license — never default.** See spec § 12
  Open Q#6.
- Depth-aware blend (Depth Anything v2 ONNX, `ml-depth` feature).

## Verifier (when expanded)

- `verify-pano-golden --max-delta-e 4` on the parallax-heavy corpus
  subset (does not exist yet — gated on T2.2).

## Prerequisites

1. P1–P5 MVP shipped.
2. **P3 unblocked** — `ort` upstream VitisAI compile bug fixed (see
   `~/.claude/projects/-Users-riabuz-Projects--Maple/memory/project_pano_p3_p4_blockers.md`).
3. **P4 unblocked** — GPU shader path validated (deferred at MVP).
4. Parallax-heavy fixture subset added to
   `test-fixtures/pano/corpus/` (gated on T2.2).
5. UDIS++ + Depth Anything v2 ONNX models pinned in
   `pano-core/models/models.toml` (gated on TX.1, which is gated
   on P3).

## Tasks (sketch — flesh out when planning)

- T6.1.1 — Add `ml-udis` feature plumbing in pano-core (similar
  shape to `ml-aliked`). ONNX model loader entry. UDIS++
  composition-mask wrapper.
- T6.1.2 — TPS warp implementation: classical TPS solver with the
  matched inliers as control points; `ParallaxMode::TpsMesh`
  becomes a no-op stub no longer.
- T6.1.3 — `ml-depth` feature plumbing. Depth Anything v2 inference.
- T6.1.4 — Depth-aware blend in `MultiBandBlender` (or sibling
  `DepthAwareBlender`) — tightens seam visibility on parallax
  scenes.
- T6.1.5 — Add parallax-heavy fixtures + tighten `verify-pano-golden`
  to 4.

## Notes

- UDIS++ research license restricts production use. Surface a
  user-facing toggle that defaults off and warns on enable.
- TPS solver should use `nalgebra` (already in pano-core).
- The `ParallaxMode::TpsMesh` enum variant exists today and panics
  / falls back to `Homography`; T6.1.2 makes it functional.
