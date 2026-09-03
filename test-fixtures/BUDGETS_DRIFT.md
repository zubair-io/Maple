# Budgets drift log

`test-fixtures/budgets.json` was re-baselined in #814 against a full-manifest
run of `src/scripts/test_color_pipeline.sh` on the current pipeline. Everything
this file used to carry — the 2026-05-22 "budgets.json is currently stale"
notice, the post-#424/#425/#431/#435/#438/#441/#494 "not measured locally,
fixtures are gitignored" placeholders, and the test_0008 first-baseline
note — described drift that the re-baseline has now absorbed and measured.
Those sections are retired rather than archived; the numbers they were waiting
for are in `budgets.json` itself, and the per-metric old/new/direction
accounting is in the #814 PR.

What follows is the drift that is still real.

## Residual: test_0018 tint (open — attributed, awaiting a reference re-render)

The #814 capture left 14 cases breaching, deliberately **not** re-baselined.
#2333 attributed both clusters (every number from a private release
`maple-cli` built at the named commit, run through the harness against the
references on disk): the twelve `test_0013` cells are green since #3265, so
only the two `test_0018` tint cells remain red today — those are the
residual this section now tracks.

**`test_0013` — closed by #3265 (#2774).** The 12-case cluster (`baseline`,
`baseline_auto`, ten full-res `sharpen_*`/`nr_*`) and its uniform +0.07 / +0.06
/ +0.05 bias were the DNG 1.6 `ProfileGainTableMap` being applied without its
`ProfileToneCurve` pair after 45c06eb1c (#1923) made the parser return `Some`.
The map is a ~1.4-stop shadow/midtone lift that Apple's PTC re-compresses;
#425 had dropped the PTC, so the lift ran alone. #3265 stops applying the map
on every path: `baseline` 11.72 / 24.37 / 41.10 → 5.88 / 8.85 / 22.75, grand
mean over the 33 neutral cases 12.62 → 8.05, all twelve cells green, 124
provisional slider cells ratcheted down and 13 re-baselined with audited
`RE-BASELINE:` markers (#2335) in that commit.

**`test_0018/tint_max` and `tint_min` — attributed to #1893 (185833efc), held
red.** The only raw-core commit between the #940 re-baseline and #1893 is #1893
itself, and the bisect is unambiguous:

| binary    | commit                                              | `tint_max` mean / p95 / max | `tint_min` mean / p95 / max |
| --------- | --------------------------------------------------- | --------------------------- | --------------------------- |
| c62a895a2 | #940 re-baseline (2026-07-10), pre-#1893            | 16.45 / 20.29 / 37.87       | 16.44 / 20.74 / 37.38       |
| 185833efc | #1893 — ACR `kTintScale`, 1/3000 uv per tint unit   | 23.32 / 32.49 / 49.95       | 23.27 / 31.62 / 43.57       |
| a85406cb1 | #1894 — Robertson slider mapping                    | 22.65 / 31.18 / 48.49       | 23.92 / 32.67 / 43.94       |
| d6ccd97de | `main` 2026-09-02 (post-#3262, #3265)               | 22.65 / 31.18 / 48.49       | 23.92 / 32.67 / 43.94       |

The ceilings 17.27 / 17.26 were seeded from the pre-#1893 tint magnitude
(3.33× smaller) and never re-measured after the scale change; #1893's "zero
breaches" note did not hold for these two cells at its own commit.

Why this is held rather than fixed or raised: **the tint references are
degenerate, on every fixture.** `tint_max.png` and `tint_min.png` are
pixel-identical for all 18 fixtures that have them (max per-pixel difference
≤ 2 code values, mean 0.00 — the MD5s differ only in PNG metadata), whether
the sidecar is tint-only (test_0001–test_0018) or carries an explicit
`crs:Temperature` beside the tint (test_0000). ACR rendered Tint −150 and
+150 to the same image; the 3–18 ΔE these references sit from `baseline` is
the `WhiteBalance="Custom"` temperature change alone. Every `tint_*` ceiling
in `budgets.json` therefore gates against "tint ignored", and a renderer
scores worse the more faithfully it applies the authored tint — which is
exactly the ordering in the table (weak legacy scale 16.4, ACR-magnitude
scale 23). Raising the two ceilings would ratify that gate; changing the
magnitude would move away from ACR's own `kTintScale`. The fix is a reference
re-render in which ACR honours `crs:Tint` (acceptance: the two PNGs differ),
followed by re-seeding all 36 `tint_*` cells from that run — tracked on
#2333.

`test_0013`'s 21 previously-ungated slider cases were seeded provisionally by
#814 and ratcheted with the attribution in #3265.

## Closed by the #814 re-baseline

**The coverage hole.** `budgets.json` gated 252 of the 796 comparisons a full
run performs. The remaining 544 logged `no-budget-entry` — every slider case
on `test_0000` through `test_0017` was ungated, and only `test_0018` ever had
slider budgets seeded. #499 was closed on the strength of a `FILTER=baseline`
run, which cannot see this. All 544 are seeded now.

**The `test_0002` sharpen/NR bias breach.** Ten `test_0002` cases had been
structurally unsatisfiable since #1936. Those keys are gated by two passes
against two different reference resolutions — the neutral pass diffs the
`down` reference, the detail pass diffs `full` — and #1936 seeded the single
budget key from the full-res measurement alone (bias −0.1074). The down-res
row measures −0.2079 on the same key, so it could never pass whatever the
pipeline did. This was a gate-plumbing defect, not colour drift.
`tools/budget_init.py` now keeps the ceiling that satisfies every pass when a
case is measured more than once.

**The `Profile::Auto` premise.** #814 was filed on the understanding that the
baseline fixtures carry no `papp:Profile` and so fall through to the raw-core
default, which became `Profile::Auto` in #536. The harness no longer depends
on that default: it pins `--profile neutral` for the Maple-vs-ACR fidelity
pass and `--profile auto` for a second pass keyed on `<fixture>/baseline_auto`.
The 41 raised ceilings are almost entirely that Auto pass, where a per-image
JPEG-fit view transform legitimately lands somewhere other than where the
AgX-default capture put it.

## Ground rules this file exists to protect

`budgets.json` is a one-way ratchet: ceilings go down, in the commit that
delivers the improvement. #814 is a sanctioned exception to that rule and is
scoped as one — a re-baseline against pipeline changes that already landed,
with every raised ceiling named and attributed. A ceiling that rises without
an attribution is a deleted gate, which is why the two `test_0018` tint cells
above are still red instead of quietly green.
