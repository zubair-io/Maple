# Ticket 09 — Re-anchor `test_color_pipeline.sh` on ACR ground truth

## Status

Open. Filed 2026-04-25. Tier 2 follow-up to commit `a730f2d`
(Maple AgX polynomial, photography-tuned).

## Why

The harness compares Maple-CLI's render against the DNG's **embedded
JPEG preview** — the *camera vendor's* own onboard tonemap. That choice
predated the existence of `test-fixtures/references/` (committed ACR
PNG renders for every fixture × every slider case). Now that ACR
ground truth exists in-tree, the embedded-JPEG comparator is the wrong
gate: it locks Maple to "match Sony / Canon / Hasselblad's onboard
JPEG engine" rather than "match the reference Adobe Camera Raw
rendering," which is the actual product target. The Maple AgX retune
in `a730f2d` exposed this gap — bias against the embedded JPEG flipped
slightly negative (-0.04) on most fixtures, but bias against ACR is
near zero on `test_0000` and the look reads as right.

## Scope

1. **Switch the harness reference**. Replace the `exiftool -PreviewImage*
   + dd` extraction in `src/scripts/test_color_pipeline.sh` with a
   lookup of `test-fixtures/references/<stem>/down/baseline.png`.
   Maple-CLI still renders to native dims; downsample the candidate
   to match the 4000-px-long-edge ACR PNG before passing to
   `compare_images.py`.
2. **Tighten budgets**. Current defaults: mean ΔE 15, p95 30, max 60,
   bias 0.05. After re-anchoring, target mean ΔE ≤ 5, p95 ≤ 10, max ≤
   30, bias ≤ 0.03. Run the harness on every fixture, set per-fixture
   budgets to the *measured* value rounded up to the next 0.5 ΔE so
   future regressions trip immediately. Budgets ratchet downward only
   from then on.
3. **Per-fixture residual decision**. test_0007 / 0015 / 0017 carry
   small per-channel bias residuals (-0.05 to -0.15 in some channels)
   that a single global polynomial can't close. Either:
   - Accept and freeze (per-fixture budget reflects the residual), or
   - Add per-camera-profile compensation in `dcp::profile_for` /
     `linearize::sensor_linearize` (HSM application, BaselineExposure
     pre-bake, or PLT — see comment in `pipeline.rs:108-113`).
   Decide via the harness numbers, not vibes.

## Out of scope

- Switching to a non-AgX view transform. The polynomial is now what it
  is; further calibration happens upstream of the view stage if at all.
- Adding new fixtures. The 17 we have cover the photometric paths
  Maple ships with.

## Acceptance

- `test_color_pipeline.sh` reads from `test-fixtures/references/` by
  default and passes on every committed fixture with the new tightened
  per-fixture budgets.
- A regression that lifts mid-gray > 0.02 in display-encoded space
  (the symptom the user originally reported) trips the bias gate.
- Documentation in `docs/testing.md` updated to describe the new
  comparison topology.

## Cross-links

- `src/scripts/test_color_pipeline.sh`
- `src/scripts/compare_images.py`
- `test-fixtures/references/REFERENCES.md`
- Commit `a730f2d` (Maple AgX polynomial)
- Commit `74c4a67` (PATH fix for build-xcframework — adjacent infra)
