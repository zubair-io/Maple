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

## Residual: test_0013 and test_0018 tint (open, not re-baselined)

The #814 capture left 14 cases breaching, and they were deliberately **not**
re-baselined. Their ceilings are frozen at the values `main` already carried,
so the harness stays red on exactly these and nothing else:

| fixture / case                        | metric | budget  | measured  | pass    |
| ------------------------------------- | ------ | ------- | --------- | ------- |
| `test_0013/baseline`                  | mean   | 6.20    | 11.72     | neutral |
| `test_0013/baseline`                  | p95    | 9.30    | 24.37     | neutral |
| `test_0013/baseline_auto`             | mean   | 5.55    | 6.57      | auto    |
| `test_0013/{nr,sharpen}_*` (10 cases) | mean   | 6.0–7.6 | 10.7–12.1 | detail  |
| `test_0018/tint_max`                  | mean   | 17.27   | 22.65     | neutral |
| `test_0018/tint_min`                  | mean   | 17.26   | 23.92     | neutral |

Why these are held rather than raised:

**`test_0013`** breaches by roughly 2× across every metric, and the breach is
in the `--profile neutral` and full-res detail passes. Neither pass touches
Profile::Auto, so the movement cannot be attributed to the Auto Profile
default that #814 re-baselined for. The whole fixture sits at mean ΔE 10–16
with a uniformly positive bias (+0.07 / +0.06 / +0.05) — a single systematic
shift on this scene rather than a per-slider defect. Its `baseline_auto` row
is much closer to budget (6.57 vs 5.55), so whatever moved is in the neutral
view-transform path. #911 already declined to re-baseline this fixture for the
same reason, classifying it as achromatic but highlight-localised and
therefore not attributable to the #443 look retirement either. Raising it now
would erase the only remaining evidence.

**`test_0018/tint_max` and `tint_min`** breach by 38–46% on mean against
ceilings that #1893 _ratcheted down_ and validated ("zero breaches on the full
harness") when it adopted ACR's kTintScale. `budgets.json` has been touched
exactly once since (#1936, additive only), so something landed after #1893
that moved tint rendering without the full harness being re-run — CI has no
fixtures, so nothing caught it. Attribution needs a bisect across the
post-#1893 colour work, which is its own ticket.

`test_0013`'s 21 previously-ungated slider cases **were** seeded, at today's
numbers, so they gate against further regression. Those seeds are provisional:
when the fixture's attribution lands, they ratchet down with it.

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
an attribution is a deleted gate, which is why the 14 cases above are still
red instead of quietly green.
