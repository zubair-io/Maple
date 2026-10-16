# Pixel exposure edge and lens resampling — #4650

Investigation is active. The production candidate remains v40 with the
existing A=-.75 lens kernel and authored settings. Alternative kernels and
FCS settings below are diagnostics, not adopted corrections. Originals,
canonical Adobe references and numerical budgets are unchanged.

## Observations

The required sensor GainMaps repair (#4647) clears `dehaze_max` and
`whites_min`. The complete v40 Pixel fixture gate is 43/44 passing; only
`exposure_max` fails, maximum ΔE 51.187453 against 34. All 163 input hashes
are unchanged. All 18 domain gates pass with a clean source audit.

At native output (299,1463), lens correction samples sensor coordinate
(317.788153,1471.428145). A nearby pre-warp bright edge at (318,1473) is
RGB [.715279,.697921,.104398]. Disabling the existing AMaZE false-color
blend only in a diagnostic changes blue to .683281. The default cubic
resample produces [.013629,.002356,.061299] at the output witness; without
FCS, it produces [.006118,.002356,.017594]. Thus changing FCS reduces false
chroma but leaves a large dark undershoot. FCS0 still fails max 41.704476.

Fresh Photoshop renders reproduce the authored reference pixel-exactly.
Isolated RAW copies supplied four controls; no original RAW or sidecar was
modified. At the same native output coordinate:

| Adobe control                       |   R |   G |   B |
| ----------------------------------- | --: | --: | --: |
| Authored Color NR 25, sharpening 40 | 247 | 224 | 221 |
| Color NR 0                          | 219 | 212 | 236 |
| Sharpening 0                        | 252 | 229 | 226 |
| Both 0                              | 230 | 223 | 248 |

The large dark fringe remains unexplained by those final Adobe settings.
Alternative existing demosaicers also fail the unchanged gate: RCD max
41.933795, dual AMaZE 51.208429 and LMMSE 37.168283. Scaling Color NR by
2^(exposure/3) yields max 41.528882; Color NR 100 yields 40.697305. These
are attribution controls, not backend substitutions or slider changes.

## Resampling counterfactuals

Only the fixed cubic coefficient table was changed in two temporary builds.
The production source was restored byte-for-byte afterward and rebuilt;
its CLI SHA equals the frozen v40 binary. A second source/input audit of
all files in the v40 domain record is unchanged.

| Lens kernel       | FCS                 | Mean ΔE |   p95 ΔE |   Max ΔE |
| ----------------- | ------------------- | ------: | -------: | -------: |
| Existing A=-.75   | authored            | 5.13959 | 11.42234 | 51.18745 |
| Catmull–Rom A=-.5 | authored            | 5.12449 | 11.33733 | 33.82375 |
| Catmull–Rom A=-.5 | disabled diagnostic | 5.13534 | 11.40036 | 26.02328 |
| Bilinear          | authored            | 5.09113 | 11.16449 | 27.50421 |
| Bilinear          | disabled diagnostic | 5.09870 | 11.21053 | 24.27627 |

Independent coefficient algebra at the existing 32 fractional phases confirms
that A=-.5 reproduces affine and quadratic samples exactly, preserves integer
samples and constants, and reduces unit-step ringing from approximately
11.10% to 7.40%. It retains signed and HDR values. A standalone check of the
actual diagnostic sampler passes 3,072 polynomial channel samples, 360 integer
sites, signed/HDR constant borders and 1,024 translated source windows.
This supports further qualification; it is not evidence that every real edge
or image improves.

Decoding all 20 corpus RAWs identifies only `test_0000` and `test_0015` as
carrying `WarpRectilinear`. The complete affected-fixture gate for A=-.5 with
**authored FCS unchanged** is running: all 86 cases plus two Auto baselines,
88 comparisons. No acceptance is claimed until that run, broader integration,
parity and performance checks finish. Canonical AMaZE remains required.

Evidence directory:
`/Volumes/Projects/maple-color-gate-20261015/pixel-resample-v40-attribution/`.
It contains exact kernel overrides, build identities, restored-production
verification, all four counterfactual renders and metrics, analytic checks,
the corpus warp inventory and the ongoing complete affected-fixture run.
Adobe controls are in `pixel-edge-adobe/`; FCS stage dumps are in
`pixel-gainmap-v39/fcs0-stage-trace/` under the same evidence root.
