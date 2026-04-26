# Ticket 10 — Tier 3 resume queue (post-AgX-retune)

## Status

Open / parking lot. Filed 2026-04-25. Items here are not blocking eachother and not blocking ship; they're the broader project queue thatgot paused while the AgX gain regression and the deep-zoom tileplacement bug were closed out (commits `a730f2d`, `1a23d8f`).

## Items

### A — Plan 3 M2 numerical Apple ↔ Web parity vs Maple AgX

The Apple ↔ WebGL parity reference fixture under `Tests/MapleCoreTests/ Fixtures/` (or wherever the M2 work landed it) was generated when theview transform was Blender 4.x AgX. Maple AgX (commit `a730f2d`) putsmid-gray ~0.65 EV lower; the reference is now ambiguous. Either:

- Regenerate the reference against current Maple AgX and re-run theparity test, **or**
- Keep the existing reference and verify both Apple and WebGL portsproduce matching outputs (since the curve is consistent acrossplatforms even after the retune, parity should hold even ifindividual values shift).

Pick (b) if the parity test still passes; it's a no-op. Pick (a) onlyif the test now fails.

Plan: `docs/superpowers/plans/2026-04-25-plan-3-m2-webgl-shaders.md`.

### B — Plan 3 M3 — Angular canvas wiring

Plan ready at `docs/superpowers/plans/2026-04-25-plan-3-m3-angular- wiring.md`. Gated on (A) being green. Wires the WebGL2 pipeline classinto the `image-canvas.component.ts` so the web hosted UI stops usingthe legacy `render_bytes` path and instead renders scene-linear viathe WebGL shader chain. ~1–2 days.

### C — Visual-diff Task 7 — slider-state matrix

Run the visual-diff harness against every committed `crs:` slider casein `test-fixtures/references/<stem>/xmp/`, not just `baseline.xmp`. ~1day. Catches regressions in slider semantics (vibrance, sharpening,NR) that a single baseline render can't.

### D — Plan 2 v2 follow-up — `oklab.metal` shared include

Plan 2 v2's NR-luminance, NR-color, vibrance, saturation, and claritykernels each redeclare the Oklab forward/inverse matrices. Extract toa shared `oklab.metal` header consumed via `#include` (CIKernel + MSLboth support this when the file lives next to the entry point in theMetal/ resource bundle). ~½ day. Pure refactor — no behaviour change.

### E — Scene-linear cache plan

Brainstorm + plan + execute. The two-phase render currently re-runsthe entire develop chain every slider tick because there's no cachekeyed on a "scene-linear-developed-pre-view-transform" snapshot. Withthe FFI split landed, a cache at that boundary would let slideradjustments that DON'T affect the develop chain (just contrast,exposure, view transform tuning) skip the expensive Rust work.

Estimated win: cold-render the develop chain once per(asset, sidecar mtime, develop-chain version), then re-run only theview tail per tick. Should hit the 16ms slider budget on the 100MPreference fixture for view-only tweaks.

### F — Orientation-aware harness comparator

Re-enables `test_0013` (currently skipped because its EXIF orientationis "Rotate 90 CW" and the harness can't align sensor-coords vs.display-coords). Either:

- Apply the inverse orientation to the candidate before diffing, or
- Generate the ACR reference with `Orientation = Normal` and bake therotation into the source PNG.

~½ day either way.

### G — Per-fixture AgX residuals (depends on Ticket 09)

After Ticket 09 lands tighter budgets, decide per-fixture whether toabsorb the small per-channel residuals on test_0007 / 0015 / 0017 orto investigate root-causes (HSM application, baseline-exposure pre-bake, etc.). See `pipeline.rs:108-113` for the deferred work.

### H — Coalesce concurrent refine decodes

Funnel the refine path through a `sharedDecode`-style deduper keyed by
`(asset, target)` so concurrent refine schedules collapse to one Rust
decode. Stale-gen bail-out (commit `d4eed05`) is the current band-aid:
it catches the common case where gen-2 hasn't started its decode yet
when gen-3 schedules, but if both are already past the early bail and
inside the synchronous Rust call, both run to completion and only one
result publishes. ~½ day. After this lands, the bail-out becomes a
no-op fast-check, not a workaround.

### I — DRY `CanvasMath` value type

Single shared `Sendable` struct that owns `fitPixelScale`, `displayW`/
`displayH` framing, `computeVisibleSourceRect`, and `refinedTargetSize`.
Eliminates the View `@State pixelScale` (`0` = fit) vs
`EditSession.pixelScale` (resolved value) duplication — the View and
the session never agree in fit mode today. Audit identified this as
fix D + F. Touchpoints: `FullImageView.swift:60-114, 132-148, 226-247`,
`EditSession.swift:344-367, 441-467`. ~½–1 day. Pure refactor — no
behaviour change beyond removing the dual-storage foot-gun.

### J — PhotoKit / sourceless metadata fallback (audit fix A)

`seedNativeImageSizeFromMetadata` is gated on `asset.primaryURL != nil`.
PhotoKit and Self-Hosted assets surface bytes through `bytesProvider`
without a stable URL → metadata seed never fires → `nativeImageSize`
stays zero → `imageExtent` returns nil → canvas shows the placeholder
forever. Add a sourceless-aware variant of `ImageMetadataReader.readPixelSize`
that takes `Data` (`CGImageSourceCreateWithData`) and walks all
subimages exactly like the URL path does (post commit `74991f6`). ~½
day. Touchpoint: `ImageMetadataReader.swift`, `EditSession.swift:752`.

## Cross-links

- Ticket 09 (color harness re-anchoring) — sibling
- Plan 3 M2 / M3 plans in `docs/superpowers/plans/`
- Plan 2 v2 plans (sharpen, NR, dehaze)
- `pipeline.rs:108-113` — pending HSM/BE/PLT bundle

