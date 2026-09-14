# Whites response gate (#3601)

This gate protects the measured edit response for both default Auto and selectable
Neutral. It is additive: `test-fixtures/budgets.json` and the existing absolute
color/Neutral gate remain unchanged. Passing this response gate does **not** mean
the absolute color gate passes. Keeping both profiles visible makes the proposed
response criterion concrete without silently removing an existing merge gate.

Run `src/scripts/test_tone_whites.sh`. It runs the mathematical/real-file tests,
verifies fixture integrity, filters the existing canonical manifest to baseline
and Whites ±100, and develops those 54 cases separately for Auto and Neutral.
It reuses `maple-cli batch --manifest ... --profile ... --no-bundled-lens` at
native resolution, with the existing AMaZE default. It does not render unrelated
slider cases or modify RAWs/sidecars.

To evaluate completed native renders without rendering again:

```sh
python3 tools/tone_whites_gate.py --candidates /path/to/auto --profile auto
python3 tools/tone_whites_gate.py --candidates /path/to/neutral --profile neutral
```

Each directory must contain all 54 files named `test_NNNN_baseline.png`,
`test_NNNN_whites_max.png`, and `test_NNNN_whites_min.png`. Native dimensions are
pinned per fixture. Candidate/reference/sidecar omissions, duplicate or incomplete
manifest entries, wrong dimensions, incorrect response direction, nonfinite
values, reference/input integrity mismatch, and a band-MAE breach fail closed.
With no RAW fixtures, orchestration visibly skips; a partially provisioned RAW
set fails. Evaluating existing outputs still requires complete verified refs.

## Metric and contract

Each PNG is interpreted as encoded sRGB. Native candidates are resized using
Pillow LANCZOS to the pinned ACR down-reference dimensions. ACR's baseline defines
the spatial masks in 5-L* bands, with at least 200 pixels per populated band.
The last band includes **L*=100**; a negative control that leaves display-white
pixels stuck must not disappear from the measurement. Earlier native-assessment
reports used half-open bands and remain historical records; this new gate's
measurements use the inclusive white endpoint.

Each renderer's own baseline is subtracted from its edited image. Band MAE is the
equal-weight mean absolute difference between the populated bands' mean signed
responses. The overall mean response must also have the expected sign for both
ACR and Maple. This measures response fidelity independently of a static baseline
color mismatch; it does not measure absolute color fidelity or replace CIEDE2000.

`measurements.json` records all 72 initial native response measurements.
`budgets.json` contains separate Auto/Neutral ceilings at 1.08 times each initial
band MAE, rounded upward to .001 L*. These are new response budgets, not changes
to any existing limit. Future changes may ratchet them down, never raise them to
accommodate a regression.

`provenance.json` pins SHA256 of each original RAW, authored Maple sidecar and
reference PNG, plus native/reference dimensions and render settings. References
are reused from the existing canonical corpus, including the six corrected
fixtures audited for #3633. No synthetic production images or new reference PNG
copies are introduced. Changed reference bytes require explicit provenance
review; they are never accepted automatically.

The tests use mathematical arrays for both signs, deliberately different renderer
baselines, incorrect/zero/doubled responses, and exact display white. They also
exercise real PNG/XMP integrity checks, missing/wrong-size candidate files,
incomplete manifests, and absent-versus-partial fixture provisioning.

## Initial native qualification

The inclusive-white metric measures candidate Auto band MAE **7.495984 /
1.899982 L*** (+100 / −100), versus shipping-main Auto **16.584413 / 3.670218**.
Candidate Auto improves all **36/36** paired fixture/rail responses; shipping
main Auto breaches all **36/36** new response limits. Candidate Neutral measures
**5.760146 / 1.197232**. The 72 per-cell initial values are retained in
`measurements.json`, and both candidate profiles qualify against their new
response limits. This remains distinct from the existing absolute-color gate.
