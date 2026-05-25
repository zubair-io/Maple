# budgets.json drift log

This file records cross-architecture rebases of `test-fixtures/budgets.json`.
Within a fixed architecture, budgets only ratchet **down** (per CLAUDE.md
§ *Objective color testing*). When the pipeline changes shape — view
transform, color resolver, etc. — the per-fixture distribution moves and
re-baselining is the right action, in the same commit that delivers the
shape change.

## 2026-05-25 — 4-tier DCP resolver + re-derived Look LUT

**Architectural changes that moved the per-fixture distribution:**

- `ba282e33` — 4-tier DCP profile resolver (#397 / PR #402). Non-bundle
  bodies that previously hit the identity-matrix fallback now resolve to
  embedded DNG DCP (Tier 1), the Adobe-derived bundle (Tier 2), embedded
  ColorMatrix-only (Tier 3), or rawler CM (Tier 4). The old per-fixture
  budgets were fit against the identity-fallback distribution.
- `d1cc1165` — Embedded tiers keyed on `ForwardMatrix` presence; bundle
  HSM backfill removed (#397 follow-up).
- This commit — 1D Look LUT re-derived from scratch against the new
  `Look::Neutral` baseline (per #397 § 4.2: a learned stage downstream
  of a changed input distribution must be re-fit). Replaces the
  `1c28350e` LUT (which was fit on top of the identity-fallback
  distribution + old bundle path).

**Aggregate result on the baseline-XMP set (16 cases):**

|              | Pre-rebase (old budgets) | Post-rebase (new LUT) |
|--------------|--------------------------|------------------------|
| Grand mean ΔE | 15.13 (Look=Neutral)     | **8.53**               |
| Grand bias R  | -0.155                   | **-0.006**             |
| Grand bias G  | -0.162                   | **-0.004**             |
| Grand bias B  | -0.163                   | **-0.007**             |

A 44% mean-ΔE reduction and a 96% bias reduction across the fixture set.

**Per-fixture transitions (5–10% headroom over new measurements):**

Most fixtures ratchet DOWN. Three fixtures see budget RAISES where the
4-tier DCP transition removed a per-fixture advantage the old
identity-fallback + Adobe-bundle path happened to give them — these are
real per-fixture costs absorbed in exchange for aggregate consistency,
and the 1D LUT's mean-shift ceiling (documented in `view/look.rs`
§ *Architectural ceiling and follow-up*, tracked as #389) cannot
recover them:

- `test_0002` mean 2.2 → 6.45, bias 0.0143 → 0.0343
- `test_0004` bias 0.0495 → 0.0986
- `test_0013` bias 0.005 → 0.0187

The harness PASSes on every baseline case at the new budgets. Going
forward, budgets in this file are subject to the one-way-down rule
again until the next architectural transition.

**Reproducer**

```bash
FILTER=baseline KEEP_TMP=1 src/scripts/test_color_pipeline.sh
src/scripts/derive_look_lut.py --candidates <KEEP_TMP>/candidates \
                               --references test-fixtures/references \
                               --out /tmp/look-lut-derive
```

The derivation script is committed at
`src/scripts/derive_look_lut.py`; rerun it if the input distribution
changes again (DCP / AgX / view transform).
