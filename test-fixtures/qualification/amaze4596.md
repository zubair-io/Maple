# AMaZE collapsed-chroma correction — #4123 / #4596

## Implementation and provenance

The implementation at `fcbeacb7e4abc86e4abb0594ea55d017191d2f04`
uses pipeline output version 24, rebased onto main
`3c4e4a25ff3f202b11d85ccd325b8219d888c781`.

At the original 100MP witness, sensor (8710, 1100), AMaZE produced
`[0.061934, 0.135634, -0.028122]`. The previous value-domain fallback
raised blue to approximately 0.165503. The maximum neighbouring measured
blue/green ratio instead supplies a ceiling of approximately 0.075553.

The fallback ceiling applies only to negative reconstructed opposite chroma.
The centre must lie strictly inside its same-colour diagonal ratio range
and agree with their mean under the existing 15% tolerance. This preserves
the fallback on colour boundaries and isolated features. Sampled CFA values,
green, FCS strength, reference images and budgets are unchanged.

## Executed focused checks

The final pixel implementation passes these physical diagnostics:

| Case                         | Maximum Delta E | Unchanged ceiling |
| ---------------------------- | --------------: | ----------------: |
| test_0000/sharpen_amount_min |           54.56 |             58.20 |
| test_0015/vibrance_max       |           52.33 |             54.90 |
| test_0018/saturation_min     |           31.34 |             33.00 |

The original sharpen case previously measured 61.12066335 across
100,663,296 compared pixels. These are filtered diagnostics, not a complete
colour qualification.

Further checks on the final implementation:

- AMaZE: 20 passed, including all existing colour-edge, isolated-feature,
  phase and tile controls, plus varying-surface and ceiling-rejection tests.
- Raw-core library: 2,769 passed, zero failed, 99 ignored.
- Recorded CPU domain suites: colour chart 7/7, grey adjustments 41/41,
  synthetic grey 6/6, grey DCP 5/5; no failures or skips.
- Recorded API sidecar contract: 3/3; Metal GPU render parity: 19/19;
  no failures or skips.

The CPU/API/Metal records bind the pixel implementation above. Additional
ceiling-rejection assertions change only test coverage.

## Canonical manifest preflight

The installed, gitignored manifest contained 777 neutral rows, including an
unfinished `test_0006/local_gradient_radial` row with no ACR images and no
budget. Its removal from the owned qualification manifest preserves every
committed budget cell: 776 neutral cases plus 20 Auto baselines = 796.
This is the count pinned by `EvidenceSource::ColorHarness` and
`color_harness_expected_cases_match_budget_cells`.

`amaze4596-corpus-preflight.json` records before/after manifest hashes and
exact budget coverage. All required RAW/XMP/reference files exist. No
authored inputs, references, budgets, or required cases were changed. The
original manifest and unfinished extra row were preserved separately.

## Complete physical gate remains required

The unfiltered harness is run through `tools/qualification/record.sh`, with
the pinned v24 CLI and temporary output on the mounted Projects volume.
The recorder hashes the complete input corpus before and after execution.

Early diagnostics of 111 rendered neutral cases found 15 budget breaches.
Independent renders of the exact main revision reproduce all 15 failures.
The table shows six examples; `amaze4596-diagnostic-audit.json` preserves
all measurements and binary identities. These results do not waive any gate:

| Case                       | Metric            |       main |         PR | Ceiling |
| -------------------------- | ----------------- | ---------: | ---------: | ------: |
| test_0000/contrast_min     | max               |   42.96925 |   42.96925 |    39.0 |
| test_0000/exposure_min     | max               |   31.34086 |   31.26155 |    30.2 |
| test_0000/highlights_max   | absolute red bias | 0.00594973 | 0.00594974 |  0.0054 |
| test_0000/nr_color_max     | max               |   47.15140 |   46.94677 |    42.9 |
| test_0000/nr_luminance_max | max               |   53.99388 |   53.99388 |    50.9 |
| test_0000/shadows_min      | max               |   39.78492 |   39.84139 |    38.0 |

The original defect is corrected, but these measurements do not establish
a passing complete colour gate. Do not infer physical qualification from
fixture-free CI success or from the focused improvements.

## Adobe reference audit

An audit of all 776 neutral cases found 36 tint cases whose authored
Temperature/Tint differ from the effective settings embedded in the reference
PNG. This check compares authored controls; it does not certify omitted defaults.

Photoshop 2026 / Camera Raw 18.7 reproduced the partial-white-balance issue on
owned copies of `test_0001/tint_max`: the authored custom Tint 150 with omitted
Temperature saved as Tint 10. Completing the Adobe-only pair with Temperature
4450 from the recorded baseline As Shot metadata made Adobe honor Tint 150.
Both newly rendered diagnostic PNGs pass the repository settings audit.

Against the corrected diagnostic reference, mean Delta E falls from 43.83 to
14.20, but maximum Delta E remains 84.52 against the unchanged 74.7 ceiling.
This is evidence of a reference-generation defect, not a passing qualification.
The original RAW, canonical XMP, canonical references and budgets were preserved.

The unbudgeted local-gradient/radial case was also rendered through Adobe on
owned copies. Adobe drops some authored local controls, so those images are
diagnostic artifacts rather than qualified references for that unfinished case.
