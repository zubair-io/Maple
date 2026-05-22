# budgets.json is currently stale

**Status as of 2026-05-22:** `src/scripts/test_color_pipeline.sh` FAILs on
multiple baseline fixtures against the committed `budgets.json`. Examples
from a recent local run on `origin/main` (`1de2c21b`):

```
test_0000 baseline   mean 13.65 > budget 13.10
test_0010 baseline   max  65.65 > budget 59.60
```

The exact failing set, per-fixture deltas, and which commit moved which
fixture are not captured here — that's the calibration-sweep work
queued below.

## Why this happened

Two reasons stacked:

1. **A documented deferred ratchet was never run.** Commit `8db890c3`
   ("feat(raw-core): canonical Sobotka AgX with inset/outset matrices +
   real sigmoid") explicitly noted in its own message:

   > Out of scope (deferred to follow-ups on #260):
   > * Color-pipeline budget ratchet (AC #4) — requires
   >   `test-fixtures/raws/` (gitignored), validated in CI after merge.

   The CI gate the commit was relying on didn't exist at the time
   (it's added in the same PR as this note). So the deferred ratchet
   was never applied while drift was accumulating. The Sobotka rewrite shifts
   mid-gray from 0.237 → 0.180 by construction — every fixture's
   perceptual delta vs ACR moves by some amount when the view
   transform changes, regardless of whether the new transform is
   "better." Budgets need to be re-baselined against the new ground
   truth.

2. **No CI workflow ran `src/scripts/test_color_pipeline.sh`.** Per
   the script's own header and `CLAUDE.md` § *Objective color testing*:
   *Budgets are a one-way ratchet — they only go down.* Until the
   workflow added alongside this note existed, that rule lived in
   human memory: enforced only on the laptop of whoever remembered
   to run the harness before merging. Anyone landing a change without
   fixtures locally couldn't trip the gate.

Several other commits in the same window plausibly contribute to
per-fixture drift (parametric scene-tone `2967e19b`, saturation
soft-clip `2448c2ea`, no-halo clarity `3f02b118`, NLM noise reduction
`6f41cbbb`, capture-sharpening wire-up `ca9a0398`, dehaze sky mask
`655d607b`). Per-fixture attribution would require running the harness
across the bisect range against the gitignored 6.5 GB fixtures.

## Why budgets aren't being raised here

`CLAUDE.md` § *Objective color testing* — and the harness header
itself — say:

> Budgets are a one-way ratchet — they can only go down. Lowering a
> budget happens in the same commit that delivers the improvement.

Raising the numbers in `budgets.json` to make the harness pass would
violate that rule and erase the signal that something needs attention.
The honest state is "the gate is currently red on `main` and the rule
is being violated until the calibration sweep below lands" — not
"green by re-baselining today's numbers as the new floor."

## How to clear this

A calibration sweep, run on a machine with `test-fixtures/raws/` and
ACR reference renders present:

1. Confirm the current Maple AgX (and any other view-transform-altering
   commits since `c43d8ca0`) is the intended ground truth — i.e. the
   pipeline shouldn't move again before re-baselining.
2. Re-render ACR references against the current Maple output set (or
   confirm the existing references in `test-fixtures/references/` are
   still the comparison target — pipeline changes don't move the ACR
   side).
3. Run `src/scripts/test_color_pipeline.sh` and capture the current
   per-fixture × per-case `mean / p95 / max / bias`.
4. Replace `budgets.json` with the captured numbers + 5–10% headroom
   (matches the seed pattern in the README block of the project for
   adding new fixtures).
5. Commit `budgets.json` with a `ratchet(budgets): recapture after
   post-AgX calibration sweep` message that names every commit since
   `c43d8ca0` that moved the deltas, so the audit trail is intact.
6. The CI workflow added alongside this note will then enforce the
   ratchet going forward.

Tracked in #332.
