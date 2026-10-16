# Film input isolation for Auto fitting — #4640

## Isolated repair on main

This branch starts at `4b519ca7898ebeccb4bcc15ca78183a16bf6bbbd` and includes
only the film-cache repair, its regression, and derived-output invalidation.
It does not include the other accumulated color-pipeline repairs.

A film LUT is supplied separately from `AdjustmentModel`. The Auto-fit fast
path previously reused the current display pixels whenever that model matched
the pinned default model, even when the external LUT had modified those pixels.
The resulting fit shared a RAW/quality/render-size cache key with no-film renders.

The fast path now also requires the external LUT to be absent. Film renders use
the existing pinned, no-film develop for fitting and retain cache reuse. The
film continues to affect the rendered image. No new cache, shader math or
per-slider work is added. GPU fit entries already use the pinned helper.

Pipeline output **26** invalidates derivatives; Auto-fit model **3** invalidates
old fit artifacts. Generated bindings and qualification summaries are updated.
Their prior-version evidence is not relabeled as new qualification.

## Before and after

The real `test_0002.dng` regression fails on unchanged main: cold and warm film
renders differ in **1,276,306 channel samples**. With the isolated fix it passes,
with zero ignored cases. It proves:

- Auto fitting engages on the physical RAW.
- Cold and warm film output is byte-identical.
- Film-first and no-film-first cache orders produce identical no-film output.
- The supplied film still changes the image.
- Original RAW bytes remain unchanged.

## Local qualification

| Check | Passed | Existing ignored cases |
| --- | ---: | ---: |
| Explicit physical regression, release | 1 | 0 |
| Core library | 2,805 | 101 |
| GPU library, Metal | 287 | 4 |
| WASM binding, native GPU-enabled target | 74 | 7 |
| FFI library, GPU-enabled | 301 | 6 |

All executed tests pass. The explicit physical regression is included in the
core suite's ignored count and is run separately above. The native WASM suite
has its real RAW fixture present, including both sized film entry tests.
This is native binding execution, not a new browser or Apple UI qualification.
Generation and its repeat, file headroom and whitespace checks pass.

### Fresh CI evidence records

CI detected that the synthetic-grey and API sidecar records still named
pipeline 25 after this isolated fix moved to 26. Their executed assertions
passed; the evidence-version check correctly failed. All five CI-recorded
suites were rerun through `tools/qualification/record.sh`, then independently
rerun with `--check`:

| Evidence source | Passed | Failed / skipped |
| --- | ---: | ---: |
| Synthetic grey | 6 | 0 / 0 |
| Color chart | 7 | 0 / 0 |
| Grey adjustments | 41 | 0 / 0 |
| Grey DCP | 5 | 0 / 0 |
| API sidecar contract | 3 | 0 / 0 |

The five records now attest to actual runs of pipeline 26. The generated
capability summaries were regenerated twice with no drift. Production source,
physical references and budgets were unchanged during these runs. Existing
physical color, Apple and Metal evidence retains its original version; this
refresh does not promote those records to current qualification. Logs, records
and source identities are archived under `qualification-refresh/` in the
directory below.

The original failure log, fixed results, exact source patch and RAW identity
are saved in `/Volumes/Projects/maple-color-gate-20261015/film-auto-fit-current-main/`.

This repairs a deterministic cache-order defect. It does not claim to clear a
case in the 806-comparison Adobe corpus or to pass that entire gate. No physical
color budget, reference, RAW or authored XMP changes, and no merge exception is
included in this qualification.
