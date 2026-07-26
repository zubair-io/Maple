# Budgets drift log — moved

The colour-budget drift record lives at **`test-fixtures/BUDGETS_DRIFT.md`**,
next to the `budgets.json` it describes. That is the copy `.gitignore`
whitelists and the copy `.github/workflows/raw-pipeline.yml` points at.

This root-level file used to carry a second, parallel record covering the
Wave-3 work (#429 auto-exposure anchor, #443 look retirement, and the #911
partial re-baseline). Two files with the same name and different contents is
how three separate agents ended up citing a stale drift note as current, so
this one is now a pointer rather than a record.

Its contents are superseded. #911's open question — six fixtures flagged as
candidate regressions with budgets deliberately left unchanged — was settled
by the full-manifest capture in #814: `test_0001`, `test_0005`, `test_0009`,
`test_0012` and `test_0014` now measure inside their committed ceilings,
`test_0002`'s breach turned out to be gate plumbing rather than colour, and
`test_0013` remains open and is tracked in the surviving file.
