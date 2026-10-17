# Common AgX highlight roll-off — #4635

This branch isolates the retained shoulder correction from the larger color
repair branch onto main `95681410fc66635dfac680266eb18befce51952f`.
It does not include the pending demosaic, GainMap, lens, sharpening or local
highlight-recovery changes. Current-main physical qualification is in progress.

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

Pipeline output changes from 25 to 26, AgX from 8 to 9, and Auto fit-model
identity from 2 to 3. Generated consumers and cache documentation are updated.
The sigmoid LUT, original RAWs, sidecars, Adobe reference pixels and numerical
budgets are unchanged by this correction.

## Qualification state

The before-change convergence control is complete and fails as expected.
Current-source view, Metal, full platform, domain, physical and performance
results will be recorded here as they complete. The old broad-branch results
are retained separately; they are not qualification of this isolated branch.

Evidence: `/Volumes/Projects/maple-color-gate-20261015/agx-common-highlight-isolated/`.
