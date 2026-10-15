# Remaining Whites failures: response attribution — #4641

## Method

The original-failure inventory still contains five negative-Whites and five
positive-Whites failures in the frozen v32 build. Before changing slider strength,
this diagnostic separates the baseline rendering error from the change produced
by Whites.

It uses the current v35 candidate's actual native-resolution AMaZE develop and
display tail for all 18 Whites fixtures, with both Neutral and default Auto.
Every reconstructed baseline is byte-identical to the corresponding production
render. Each image supplies 16,384 deterministic stratified samples. The same
production display tail evaluates 41 Whites positions from −100 to +100 in
steps of five, retaining the image's real scene anchor and fitted Auto artifacts.
At zero Whites, sampled float output agrees exactly with the native baseline.
Adobe pixels are comparison targets only; they never supply or reconstruct
Maple's scene input.

All 36 profile/fixture captures completed. Before/after hashes confirm that all
234 declared RAW, XMP and reference inputs are unchanged. The frozen diagnostic
binary SHA-256 is
`e002d4e76693180628049a7ccb90f4cf7c74a23e3b3d9055e79fca6b69508ca6`.

These are native sampled diagnostics, not the canonical full-image color gate.
They cannot qualify maxima, replace matched downsampling, or certify a response
budget. The sample-band population floor differs from the full-image response
gate. Interpolated predictions between sampled slider positions are also
explicitly provisional.

## Negative Whites: baseline error dominates

For these five failing Neutral cases, the signed mean luminance errors decompose
exactly as baseline error plus response error:

| Fixture   | Baseline error, L\* | Whites −100 response error, L\* | Final error, L\* |
| --------- | ------------------: | ------------------------------: | ---------------: |
| test_0002 |              −15.87 |                           +2.41 |           −13.46 |
| test_0008 |               −9.19 |                           +1.07 |            −8.12 |
| test_0013 |               −3.86 |                           +0.63 |            −3.23 |
| test_0015 |              −12.78 |                           +1.63 |           −11.15 |
| test_0018 |              −15.96 |                           +0.86 |           −15.10 |

A positive response error here means Maple darkens less than Adobe; it is already
partially cancelling the negative baseline error. Reducing negative-Whites
strength further can improve absolute final-image error while making the slider's
measured response less accurate. That is not an acceptable correction. No
negative-Whites constant changed.

This attribution does not establish the cause of each baseline mismatch or
justify changing the intentional Neutral/AgX rendering intent. Baseline
colorimetry, exposure and reference-contract evidence remain separate questions.

## Positive Whites: a shared amplitude change did not qualify

The positive response is not uniformly too strong. For example, test_0017 Neutral
has a +8.80 L\* mean response error, while other Auto fixtures need more response.
The same pre-AE anchor is shared by both profiles, even though their actual
pre-view exposure and fitted display transforms differ.

A feasibility sweep evaluated 25,958 lower-or-equal-amplitude variants of the
existing two-coefficient anchor law, retaining its current clamps and bump shape.
The selection rule rejected a prediction that introduced another response-budget
breach or worsened an existing one. Only the unchanged coefficients survived
that sampled screen.

The variant with the lowest unconstrained average predicted error changed the
intercept/slope from 2.0/0.58 to 1.875/0.57. Its average sampled band error moved
from 6.764 to 6.674 L\*, but it introduced predicted breaches on test_0018 in both
profiles and on Auto test_0004 and test_0003. It was rejected before any production
edit. This finite sweep is evidence against that simple amplitude adjustment;
it is not proof that every possible response model is infeasible.

## Outcome and evidence

No rendering code, reference, budget or case changed for this investigation.
The remaining work requires attribution of the baseline mismatches and a response
model that respects both profiles, followed by actual full-image qualification.
The issue remains open.

The task archive `whites-response-4641` retains the frozen diagnostic source,
source/binary/input identities, all 36 captures, response measurements,
`baseline-decomposition.jsonl`, and `anchor-fit-feasibility.json`. The diagnostic
source was removed from the checkout after its verified binary was frozen; it
is not part of the shipped pipeline.
