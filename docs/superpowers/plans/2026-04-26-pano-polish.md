# Pano P7 — Polish (placeholder plan)

> **Status:** Placeholder created 2026-04-26 to satisfy
> [`docs/tasks/04-maple-panorama-spec.md`](../../tasks/04-maple-panorama-spec.md)
> task **T7.1**. Expand into a full execution plan when MVP (P1–P5)
> ships.

## Scope (when expanded)

Per [spec § 11 P7](../../tickets/04-maple-panorama-spec.md):

- LPIPS gate (perceptual stretch metric — Python `torch` fallback or
  ONNX LPIPS in CI).
- ICC round-trip test suite for ProPhoto → Display P3 → sRGB export
  paths.
- `pano-cli` example binary (native-only) — promotes the existing
  `pano-smoke` smoke binary into a polished CLI.
- Cross-comparison doc vs. the engine / Hugin (qualitative + ΔE
  comparison).

## Verifier (when expanded)

- `verify-pano-golden --max-delta-e 3` on the full corpus.
- `verify-pano-perf` within [spec § 8](../../tickets/04-maple-panorama-spec.md)
  targets on both macOS + iPhone.

## Prerequisites

1. P1–P5 MVP shipped.
2. P3 unblocked (LPIPS comparison needs a baseline; ort needs to
   work for the ONNX LPIPS path).
3. `verify-pano-perf` recipe wired (gated on TX.2 — currently
   blocked because there's no justfile).
4. Real `test-fixtures/pano/` corpus (gated on T2.2).

## Tasks (sketch — flesh out when planning)

- T7.1.1 — LPIPS metric: Python script under `src/scripts/` that
  takes two PNGs and produces an LPIPS distance; integrate into
  `test_pano_pipeline.sh` (or its successor) as an additional
  reportable metric.
- T7.1.2 — ICC round-trip suite: a Swift test that exports a
  test image with each `OutputColorSpace` (`.sRGB`, `.displayP3`,
  `.proPhoto`), reads the resulting file's tagged ICC, and verifies
  the byte-level profile matches the embedded one. Catches
  regressions in `MapleExporter.encodeImage` color tagging.
- T7.1.3 — `pano-cli` polished binary at
  `src/raw-pipeline/pano-core/src/bin/pano-cli.rs`. Adds:
  progress reporting, manifest input file (multiple input groups),
  better error messages, optional `--gen-fixtures` and `--bench` modes.
- T7.1.4 — Cross-comparison doc at `docs/pano-comparison.md`. Run
  the same 12-scene corpus through Maple, "the engine" (whatever
  reference panorama tool the team standardises on), and Hugin.
  Tabulate ΔE deltas and qualitative observations.

## Notes

- LPIPS requires either Python `torch` + `torchvision` (heavy CI
  dep) or an ONNX LPIPS model loaded via `ort` (blocked until ort
  works). Lean toward the ONNX path so it's installable in the
  same wheelhouse as the rest of the ML stack.
- The `--max-delta-e 3` budget on the full corpus is aggressive —
  may require T6 (parallax mode) and T4 (GPU blend) to land first
  to hit it.
