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

## Completed Auto baseline controls

All 20 Auto baselines pass the canonical comparison pass with zero breaches,
missing inputs, skipped comparisons or errors. All 86 original inputs used
by this pass were rehashed afterward and remain unchanged; the frozen renderer
binary also remains unchanged. The complete unrounded records are in
`color-suite-5000-auto-baselines.json`. Neutral and native-detail comparisons
are still pending, so this is not a passing full-suite claim.

## Nikon residual attribution

The fresh `test_0014/sharpen_amount_max` PNG is byte-identical to the archived
AgX candidate (`490b2f52d0e16adcf0d5b1cb0590a7aac667bfea5ea43d90123432b03fbeb691`).
The archived pre-AgX control, AgX candidate and Adobe reference hashes were
independently revalidated. Existing pixel attribution therefore applies to this
exact current output: 1,164,774 changed green pixels worsen their absolute
reference error, versus 42,442 that improve it. The extra green bias is
0.00010419227435023; its budget excess is 0.00007013038482760. The change is
concentrated at reference green codes 128–241, with none at codes 0–127.
Red and blue already breach on the pre-AgX control, so clearing the new green
breach alone would not clear this whole case. The companion attribution JSON
preserves the source hashes and full bin totals.

## C2 common-highlight probe checkpoint

The first bounded highlight experiment is preserved under
`experiments/c2-common-highlight/`. It passes 52 core tests and 10 GPU parity
tests, and clears two failing channel measurements, but clears **zero of the
three failing physical cases**. A retained control also regresses:
`test_0007/texture_max` passes on captured main (max 42.82735 <= 43.4)
and fails the candidate (max 43.66641 > 43.4). The probe was rejected and
its production source changes were reverted.
The exact patch, test logs, unchanged input verification and raw comparison
metrics are retained so this investigation can be resumed without lost work.
The full main baseline is still running; no complete-suite reduction is claimed.

## Authored-setting audit of all existing references

The new read-only audit checked all 806 saved reference outputs against only
the controls explicitly authored in their canonical XMPs. It found 760 matches,
36 mismatches (all tint endpoints), and 10 PNGs without effective Adobe metadata
(all test_0002 detail/NR down references). A match does not certify omitted
controls. These counts describe reference integrity, not color-gate failures.
All 1,582 unique canonical sidecar/PNG inputs were rehashed against the original
baseline identities and remain unchanged. The compact audit report retains all
46 nonmatching/uncertified records. Eight new audit tests and all 27 reference
tooling tests pass; Ruff passes.

Two isolated Photoshop captures confirm the tint mismatch for test_0007. Their
settings verifier passes; with the unchanged renderer and budgets, tint_max
passes against the verified capture, while tint_min still fails maximum error.
The originals remain intact and no canonical failures are counted as cleared.
Full settings, hashes and matched measurements are retained under
`experiments/wb-reference-diagnostic/`.

## Staged reference repair proposal and resize diagnostic

All 36 mismatched tint endpoints have now been independently recaptured using
Photoshop on isolated RAW copies. Every capture passes the complete effective
settings verifier. All original RAW/XMP/PNG hashes and all staged RAW copies
remain unchanged; all 18 As Shot baselines were also revalidated. Original and
new dimensions match, and only effective Temperature/Tint changed in the saved
settings. The proposed capture hashes and settings changes are committed in
`color-suite-5000-tint-recapture-proposal.json`; the captures are backed up on NAS.
They have not been adopted. User choice about a separate versioned reference
set is pending; no canonical corpus changes or budget changes have been made.

A separate one-case diagnostic finds that the legacy resize protocol creates
the maximum-error breach for test_0007/clarity_max: the newly saved Adobe down
reference has exactly the same RGB pixels as the original, yet comparing both
native images through Lanczos gives max 40.90518 <= 42.1 instead of
42.24899 > 42.1 with the Adobe BICUBICSHARPER down reference. This is evidence
for that one case, not a full-family claim or a canonical failure reduction.
Exact metrics and hashes are under `experiments/resize-reference-diagnostic/`.

## First qualified native companions — three-case chunk

The companion qualifier adds a separate manifest using the suite's existing
`native-pair-lanczos-v1` protocol. It writes no original asset or source manifest.
A captured down image must be RGB-identical to the original, use identical RAW
and canonical XMP bytes, and pass the complete effective Adobe settings checks.
Native and newly saved down metadata must match exactly. Original assets remain
intact; the separate down capture carries the identical RGB pixels plus export
metadata matching the new native companion. Unknown active controls are rejected.

Three test_0007 cases qualify. Canonical before/after comparisons use the same
captured-main PNGs and budgets: clarity_max max changes 42.24899 -> 40.90518
(ceiling 42.1); whites_min 42.20815 -> 41.30722 (ceiling 41.4). Both cases now
pass under the qualified comparison protocol. texture_max remains passing
(42.82735 -> 41.31910, ceiling 43.4). Thus this focused chunk resolves **two
protocol-related failures, zero new failed cases**, with no renderer changes.
This is not a passing full-suite result or a count of renderer bugs fixed.

Three test_0000 captures fail exact RGB identity: 50–60 pixels differ, by at
most one or two code values, across the Adobe 18.2.2/18.7 capture versions.
They were not qualified, and no extra pixel tolerance was introduced. Exact
measurements and successful/rejected capture identities are committed under
`experiments/native-companions/`. The complete original-protocol baseline
continues independently; no original reference or budget was overwritten.

Validation: all 13 companion qualification tests, 19 complete-metadata tests
and 27 Adobe reference-tooling tests pass; Ruff passes. The final qualifier
produces a byte-identical manifest to the one used by the physical comparisons.

## Complete Neutral/Auto passes and tint preview

The original-protocol run has completed all 606 Neutral comparisons: **64
fail**, with zero comparison errors. All 20 Auto comparisons pass. Native
detail remains in progress, so these are not whole-suite totals. Sony
test_0011 contributes 25 of the 64 Neutral failures. Every one of the original
1,860 input paths has additionally been copied into a read-only, SHA-verified
snapshot (957 unique contents), preserving inputs even if old worktrees go away.
Reference paths must come from the frozen manifest: Sony uses the separate
tone-slider-sprint capture root, not the primary checkout's older lens-enabled
reference. No original input was changed.

All 36 proposed corrected tint captures were compared to the already retained
main PNGs. Original references fail 18; corrected captures fail 16: **9 clear,
7 newly fail**. This preview is not adopted and is not a renderer-fix count.
It preserves all 36 cases, including newly exposed errors. Full raw metrics
are in `color-suite-5000-tint-preview.json`.

Fresh current-main Sony attribution repeats the existing deterministic
neutral/flat-pixel probe on the exact canonical reduced pair. The required
median EV changes are -0.4233, -0.9262 and -1.1817 for reference code bands
10–30, 30–60 and 60–90; their +/-1-code bounds do not overlap. This rules out
a single exposure-offset correction as a sufficient fix. It does not establish
Adobe's scene-linear truth or justify fitting a camera-specific curve. The
compact input/filter/selection identities and results are retained in
`color-suite-5000-sony-attribution.json`.
