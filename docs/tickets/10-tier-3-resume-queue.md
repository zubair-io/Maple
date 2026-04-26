# Ticket 10 — Tier 3 resume queue (post-AgX-retune)

## Status

Open / parking lot. Filed 2026-04-25. Items here are not blocking each
other and not blocking ship; they're the broader project queue that
got paused while the AgX gain regression and the deep-zoom tile
placement bug were closed out (commits `a730f2d`, `1a23d8f`).

## Items

### A — Plan 3 M2 numerical Apple ↔ Web parity vs Maple AgX

The Apple ↔ WebGL parity reference fixture under `Tests/MapleCoreTests/
Fixtures/` (or wherever the M2 work landed it) was generated when the
view transform was Blender 4.x AgX. Maple AgX (commit `a730f2d`) puts
mid-gray ~0.65 EV lower; the reference is now ambiguous. Either:

- Regenerate the reference against current Maple AgX and re-run the
  parity test, **or**
- Keep the existing reference and verify both Apple and WebGL ports
  produce matching outputs (since the curve is consistent across
  platforms even after the retune, parity should hold even if
  individual values shift).

Pick (b) if the parity test still passes; it's a no-op. Pick (a) only
if the test now fails.

Plan: `docs/superpowers/plans/2026-04-25-plan-3-m2-webgl-shaders.md`.

### B — Plan 3 M3 — Angular canvas wiring

Plan ready at `docs/superpowers/plans/2026-04-25-plan-3-m3-angular-
wiring.md`. Gated on (A) being green. Wires the WebGL2 pipeline class
into the `image-canvas.component.ts` so the web hosted UI stops using
the legacy `render_bytes` path and instead renders scene-linear via
the WebGL shader chain. ~1–2 days.

### C — Visual-diff Task 7 — slider-state matrix

Run the visual-diff harness against every committed `crs:` slider case
in `test-fixtures/references/<stem>/xmp/`, not just `baseline.xmp`. ~1
day. Catches regressions in slider semantics (vibrance, sharpening,
NR) that a single baseline render can't.

### D — Plan 2 v2 follow-up — `oklab.metal` shared include

Plan 2 v2's NR-luminance, NR-color, vibrance, saturation, and clarity
kernels each redeclare the Oklab forward/inverse matrices. Extract to
a shared `oklab.metal` header consumed via `#include` (CIKernel + MSL
both support this when the file lives next to the entry point in the
Metal/ resource bundle). ~½ day. Pure refactor — no behaviour change.

### E — Scene-linear cache plan

Brainstorm + plan + execute. The two-phase render currently re-runs
the entire develop chain every slider tick because there's no cache
keyed on a "scene-linear-developed-pre-view-transform" snapshot. With
the FFI split landed, a cache at that boundary would let slider
adjustments that DON'T affect the develop chain (just contrast,
exposure, view transform tuning) skip the expensive Rust work.

Estimated win: cold-render the develop chain once per
(asset, sidecar mtime, develop-chain version), then re-run only the
view tail per tick. Should hit the 16ms slider budget on the 100MP
reference fixture for view-only tweaks.

### F — Orientation-aware harness comparator

Re-enables `test_0013` (currently skipped because its EXIF orientation
is "Rotate 90 CW" and the harness can't align sensor-coords vs.
display-coords). Either:

- Apply the inverse orientation to the candidate before diffing, or
- Generate the ACR reference with `Orientation = Normal` and bake the
  rotation into the source PNG.

~½ day either way.

### G — Per-fixture AgX residuals (depends on Ticket 09)

After Ticket 09 lands tighter budgets, decide per-fixture whether to
absorb the small per-channel residuals on test_0007 / 0015 / 0017 or
to investigate root-causes (HSM application, baseline-exposure pre-
bake, etc.). See `pipeline.rs:108-113` for the deferred work.

## Cross-links

- Ticket 09 (color harness re-anchoring) — sibling
- Plan 3 M2 / M3 plans in `docs/superpowers/plans/`
- Plan 2 v2 plans (sharpen, NR, dehaze)
- `pipeline.rs:108-113` — pending HSM/BE/PLT bundle
