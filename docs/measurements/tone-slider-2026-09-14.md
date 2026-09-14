# Tone-slider calibration, 2026-09-14

Issues: #3601 (Whites), #3631 (Exposure investigation). Base: `3572cbeb99bb1242abd6b842c503d2f8618d94f4`.

## Decision evidence

The image-dependent Whites direction is promising, but the handoff's 4.19 L* is
not a production-render result. The historical calibration derives **per-pixel
input tone positions** from ACR's baseline, even when its **per-image percentile**
is measured from RAW. These are distinct inputs. Both the 2.93 oracle and the
4.19 surrogate are unsuitable shipping targets. The old diagnostic RAW develop
also omitted production stages; `dump_scene_linear` now calls production develop.

The current experiment uses an as-shot linear Rec.2020 P99, before user white balance and auto-exposure,
measured from at most 16,384 deterministically jittered samples. The statistic
projects the as-shot camera buffer through the shared linear DCP matrix and
soft-floor; it deliberately excludes HSM and subsequent appearance operations.
Lens correction, highlight recovery and sized downsampling precede capture.
It is stable under WB/Exposure/Whites edits, not every possible decode change. Its positive Whites amount
is multiplied by `clamp(2.0 - 0.58 * ev, 0.1, 1.1)`. The original 0.20 bump then
has maximum displacement 0.22, below its monotonicity ceiling of 0.226667.
Negative Whites keeps its independently calibrated 0.159 ramp. A single decoded
image anchor is retained through Apple, Windows, WASM, CPU/GPU and detail paths.
No new probe or derivative cache is introduced. The existing CPU chain cache key
includes the decoded anchor.

Current 1024px production renders, all 18 fixtures (including the WB-stable anchor and jittered sampler):

| Profile / rail | Main band MAE L* | Candidate band MAE L* |
| --- | ---: | ---: |
| Auto +100 | 16.945 | 7.648 |
| Auto -100 | 3.603 | 1.919 |
| Neutral +100 | 16.379 | 5.594 |
| Neutral -100 | 3.010 | 1.201 |

These are calibration-set results, not held-out accuracy. All 36 baseline PNGs
are byte-identical to main. A separate 512px CIEDE2000 diagnostic improves average
error in each profile/rail combination, but has per-fixture regressions. It is
not a substitute for the native-resolution canonical colour gate.

The divergent model checks rejected a stronger rising-only ramp and a rational
interval remap: their fixed-strength production band errors were worse than the
bounded bump in Neutral. The retained design prioritizes actual render fidelity,
monotonicity and a scalar retained at decode over a stronger surrogate fit.

## Exposure: corrected attribution

Auto disables auto-exposure when an embedded JPEG can be fitted; Neutral keeps
it enabled by default. Comparing those profiles changes the AgX operating point
as well as the fitted tail. It does not isolate the tail's slope.

A controlled experiment adds Neutral with AE Off, measured on the **same spatial
pixels selected once by Auto baseline L* 60–80**. Means across all 18 fixtures:

| Render | +1 EV delta L* | -1 EV delta L* |
| --- | ---: | ---: |
| Auto | 10.820 | -15.554 |
| Neutral, AE On | 8.420 | -11.122 |
| Neutral, AE Off | 12.285 | -17.024 |

Fixtures 0001 and 0018 have no active Auto fit and need exclusion when attributing
the fitted tail itself. Positive amplification remains notable on 0002 and 0017;
the fitted tail does not generally amplify exposure. The earlier blanket slope-cap
plan is therefore not justified by the original comparison.

Two slope-cap experiments failed the product objective: they changed baselines
without consistently reducing exposure response. The output-midgrey cap worsened
average baseline DeltaE from 6.796 to 6.958 in the 512px diagnostic, and fixture
0011 from 4.071 to 5.939. No cap is in the candidate. Matched ACR ±1 EV references for 0002/0017 are
needed before treating those outliers as a demonstrated defect; existing ACR
sidecars are at ±5 EV. This is tracked in #3631.

A separate fit against real measured Maple curves found that adding AE gain
improves leave-one-fixture-out band MAE only 3.0% (7.168 to 6.952), with both
profiles held out together. This reverses the surrogate experiment's categorical
rejection of AE, but does not justify coupling the retained anchor to AE or
solve the colour-budget failures. No AE predictor is in the candidate.

## Reproduction

Run from the repository root with the ignored RAWs, references and manifest
installed. Reference cases are test_0000 through test_0015, test_0017 and test_0018.

```sh
cargo build --manifest-path src/raw-pipeline/Cargo.toml --release -p raw-core --example tone_sprint --example tone_exposure_isolation
src/raw-pipeline/target/release/examples/tone_sprint test-fixtures/references/manifest.json /tmp/tone-candidate test_0000 1024
src/raw-pipeline/target/release/examples/tone_exposure_isolation test-fixtures/references/manifest.json /tmp/tone-isolation test_0000 1024
# Repeat for every fixture, then:
python3 tools/tone_sprint_report.py /tmp/tone-candidate --output /tmp/tone-report.json
python3 tools/tone_exposure_report.py /tmp/tone-candidate /tmp/tone-isolation --output /tmp/exposure-report.json
```

The render diagnostic loads the baseline XMP, overrides only the stated controls,
uses Full quality and the production sized renderer, supplies the RAW path for
embedded-preview extraction, and does not inject bundled lens corrections. ACR
PNGs are comparison targets only; they never enter Maple's rendering inputs.

The reporter uses ACR baseline to select common spatial masks in 5-point L* bands,
requires at least 200 pixels per band, compares each renderer's edit-minus-own-
baseline, averages absolute band errors within a fixture, then averages fixtures.
It fails on missing fixture outputs. Empty bands are reported as null.

The native canonical gate, GPU parity, synthetic grey gate and host ABI checks
remain required. No perceptual budget is widened by this experiment.

The first native run compared 76 cases (56 Neutral and 20 Auto baselines): 21
failed case budgets, comprising five baselines and 16 Whites cases. A fresh main
control reproduced all five baseline failures across six comparisons, with
byte-identical PNGs to the candidate: tracked as #3633. No reference, candidate or
RAW was skipped. The revised stable-anchor run also fails 21/76: five baseline and 16 Whites
cases. Exact native failures are in `tone-slider-native-failures.json`. The
candidate is not shippable under the current gates.

Validation completed: 2,378 raw-core unit tests passed (92 ignored); production
anchor integration tests 2/2; CPU/GPU direct/full/live/FFI parity passed; Apple
build and 40 host tests passed; Windows native ABI/anchor tests 9/9; WASM GPU
target check passed. These do not override the failed perceptual gate.
