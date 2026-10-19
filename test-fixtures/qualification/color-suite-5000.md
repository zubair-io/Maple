# Physical color-suite repair — #5000

The baseline renderer is captured main `cf62d12ddc573cff68780e7754f7b5b63f7ae621`
(pipeline output 29). Reporting commit `34127de8db` adds unrounded case metrics
without changing rendering, comparison calculations or budgets. All 776 manifest
cases across 20 fixtures have their declared RAWs, sidecars and references.
The baseline records SHA-256 identities for 1,860 original input files.

## First current-main controls

These are three focused comparisons, not a complete-suite failure count.
All three fail their unchanged budgets. Ten original input files were
revalidated after rendering and comparison; none changed.

| Case | Resolution | Breached channel biases | Bias ceiling |
| --- | --- | --- | ---: |
| `test_0003/highlights_max` | down | R 0.012388155268644067 | 0.0112 |
| `test_0011/wb_daylight` | down | R 0.05965050455547201; G 0.033143953543420555 | 0.0323 |
| `test_0014/sharpen_amount_max` | full | R 0.17733041259494245; G 0.16167013038482758; B 0.1678395230452218 | 0.1616 |

The companion JSON retains every unrounded metric, pixel count and protocol.
No rendering fix or cleared physical failure is claimed by this checkpoint.

## Complete baseline run

The full run is in progress. It uses four bounded render processes, the frozen
main CLI and unchanged canonical comparison bodies. Ten verified completed
renders are retained from the initial serial run and focused controls.
Completion requires all 806 comparisons, 796 unique budget cases, zero comparison
errors, unchanged input hashes and an unchanged binary.

The archived historical count of 99 failures is not a result for this revision.
Full-run output and input identities are retained under
`/Users/riabuz/.codex/color-suite-evidence/5000/baseline-cf62d12ddc`.

## Reporting regression checks

The added three-pass test reproduces missing metric fields on unchanged main.
After the reporting fix, all 12 harness tests and 9 accounting tests pass.
The draft PR remains unmerged while physical fixes and full qualification proceed.
