# Common AgX highlight roll-off — #4635

This branch isolates the retained shoulder correction from the larger color
repair branch onto main `95681410fc66635dfac680266eb18befce51952f`.
It does not include the pending demosaic, GainMap, lens, sharpening or local
highlight-recovery changes. The full historical comparison has completed;
current-main integration is recorded separately below.

## Reproduced defect

The existing maximum-channel ratio curve retains finite color ratios at
arbitrarily high exposure. On unchanged main, the new convergence control
fails for `[1.0, 0.05, 0.05] * 1e6` at contrast -100: the output remains
`[0.7282911, 0.04456131, 0.04171583]`. The control requires the channel spread
to fall below `1e-4` at the neutral shoulder.

## Correction and compatibility

When the minimum inset channel is at or below diffuse white, the existing
ratio arithmetic remains exact, with one curve sample. Above diffuse white,
a Hermite ramp in log exposure introduces compression toward the minimum's
own curve endpoint. The ramp reaches full support at the existing AgX
shoulder. The middle channel retains its fraction between the extrema.
There is no fitted camera parameter or scene-specific condition.

CPU, WGSL, the scalar GPU oracle and the inverse change together. The inverse
retains the ratio fast path and uses a monotone bracket for common highlights.
Tests cover the unchanged neutral curve, signed inputs, the diffuse-white
boundary, monotonicity and inverse round trips. A separate Metal test covers
all six channel orders across the onset and shoulder at contrast/whites
extremes, including exact alpha preservation.

The isolated run used output version 26 and Auto fit-model version 3.
After integrating the landed film fix, this change raises pipeline output
from 26 to 27, AgX from 8 to 9, and Auto fit-model identity from 3 to 4. Generated consumers and cache documentation are updated.
The sigmoid LUT, original RAWs, sidecars, Adobe reference pixels and numerical
budgets are unchanged by this correction.

## Qualification state

The before-change convergence control fails as expected. Qualification below
uses isolated runtime `7716f09afa2daa2f758d4e3e1e1363bd2535fa7b`.

### Platform and domain controls

| Suite | Passed | Failed | Ignored |
| --- | ---: | ---: | ---: |
| raw-core library | 2,813 | 0 | 100 |
| Metal GPU | 288 | 0 | 4 |
| C FFI | 301 | 0 | 6 |
| native-host WASM bindings | 74 | 0 | 7 |
| Total | 3,476 | 0 | 117 |

The focused subsets also pass: 220 view tests and 10 AgX Metal tests. Their
largest reported CPU/Metal absolute error is `4.9471855e-6`, below `1e-4`.
These subsets are included in the platform totals above. Hue/chart tests
(18), synthetic grey (6), grey adjustments (41), and DCP (5) all pass.
Code generation and repeat generation produce no drift.

The banding gate compares all 90 ramps on both the candidate and a main
control with the same renderer tree as current main
`95681410fc66635dfac680266eb18befce51952f`. Both pass 89 and fail the same
Auto 1 neutral-tail ramp. Its second-difference maximum is exactly
`0.004709126531853625` on both, above the unchanged `0.004007` ceiling.
Spike ratio and flat-run metrics also match exactly. There are no newly
failing banding metrics. Auto 2 and all synthetic slider ramps pass.

### Physical comparisons

The full unchanged-main control has now completed all 806 comparisons:
606 standard cases contain 71 numerical breaches, 180 native detail cases
contain 41, and all 20 Auto baselines pass. That is **112 numerical failures**
under the frozen reference protocol. Inputs, comparator sources and the
executable remain unchanged. The renderer tree is identical to main
`95681410fc66635dfac680266eb18befce51952f`. The 18 NR authoring gaps require
their qualified overlay for final canonical qualification; this control
does not certify those historical metadata packets.

The first matched physical control clears `test_0000/contrast_min`:

| Metric | Main | Candidate | Ceiling |
| --- | ---: | ---: | ---: |
| mean ΔE2000 | 5.947019 | 5.941143 | 6.5 |
| p95 ΔE2000 | 10.284551 | 10.284513 | 11.3 |
| max ΔE2000 | 39.316267 | 37.767686 | 39.0 |

Every candidate RGB bias channel also passes. Both comparisons use the same
10,668,000 pixels, original RAW, sidecar and reference; hashes are unchanged.
This is one failure cleared on the candidate, not a whole-corpus result.

The 87-comparison selection completed with **73 passes and 14 failures**,
against 18 failures on the matched main control. It includes the historical
AgX cohort, every Neutral baseline, all test_0000 native detail controls and
maximum sharpening on test_0004 and test_0014. The four cleared cases are
test_0000/contrast_min and test_0007/tint_max, wb_auto and wb_tungsten. All 20
Auto baselines pass. Source, input and executable hashes remain unchanged.

### Complete matrix and authorized residuals

The full candidate run completed all **806 comparisons: 707 pass, 99 fail**.
Against the matched historical main control (112 failures), **14 cases clear
and one previously passing case fails**, a net reduction of 13. Standard
cases account for 58 failures; native detail has 41; all 20 Auto baselines
pass. Every physical input, comparator source and frozen executable hash is
unchanged. The full run uses all 18 qualified Adobe NR authoring overlays;
the installed canonical-manifest migration remains tracked by #3678.

There are three new metric/channel breaches, even though two of those cases
already fail other metrics on main:

| Case | Metric | Candidate | Unchanged limit |
| --- | --- | ---: | ---: |
| test_0003 / highlights_max / Neutral | red bias | 0.012389324234270775 | 0.0112 |
| test_0011 / wb_daylight / Neutral | green bias | 0.0331464444110469 | 0.0323 |
| test_0014 / sharpen_amount_max / native detail | green bias | 0.16167013038482758 | 0.1616 |

The Nikon green bias is 0.16156593811047731 on the matched main control.
The first row is the newly failing whole case. Sixteen individual metric
breaches clear. Exact case/channel classifications are retained in
`physical-full/matched-main-classification.json` alongside the full metrics.

On 2026-10-17 the repository owner instructed this session to merge after
being told the 14 cleared / one new case and three new metric breaches.
This explicitly accepts these measured residuals for this change, in addition
to the existing session exception for failures already on main. **The physical
gate still fails; no threshold is increased and no pass is claimed.** Follow-up
#4914 tracks repairing all three added breaches without losing the gains.

### Integration on current main

Rebased onto main `1b273fb87851d3d608bebdba8ee6621cf2b62a16` after #4770.
The common-highlight algorithm is unchanged. The film fix stays in place;
new cache identities prevent reuse of fits made with the previous AgX tail.
Fresh platform and selected physical integration checks are required before
merge. The 112-to-99 full-corpus result above belongs to its frozen historical
source revisions and is not relabeled as a new current-main measurement.

For test_0000 luminance NR, the selection uses the separately qualified Adobe
authoring overlay from #4851 on both sides. Replaying main against that same
reference leaves its maximum exactly `53.99387847200087`, still above `50.9`.
The reference correction therefore does not clear that rendering failure.

### Warm GPU timing

Four alternating main/candidate rounds use the existing Whites harness:
60 ticks each at Whites 0, +100 and -100, on a 1732px viewport derived from
the 100MP test_0000 RAW. Completion includes GPU work without pixel readback.

| Measurement | Main | Candidate |
| --- | ---: | ---: |
| median of per-run medians, ms | 1.819219 | 1.802281 |
| per-run p95 range, ms | 3.068833–3.775333 | 3.374417–7.591833 |
| maximum observed tick, ms | 34.607708 | 39.861833 |
| warm GPU pool allocations | 0 | 0 |

All per-run p95 values are below the 16ms target and observed maxima are below
the 50ms hard limit. This measures the Neutral GPU chain with zero NR and
sharpening; it does not qualify every app slider configuration. Concurrent
system work may affect timing tails. Source and RAW hashes are unchanged.

### Evidence recovery

A network-share disconnect interrupted result recording and physical work.
The platform audit revalidated every frozen source hash and repeated the
native WASM suite locally before completing the platform record. The
interrupted physical attempt produced zero comparisons and is recorded as
interrupted, despite its shell exit status. Its 23 valid rendered PNGs were
CRC-checked and retained; the resumed run renders only missing outputs.
The original interrupted identities and all recovery records are preserved.

The old broad-branch results remain separate from this isolated qualification.

Evidence: `/Volumes/Projects/maple-color-gate-20261015/agx-common-highlight-isolated/`.
