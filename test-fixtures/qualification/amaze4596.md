# AMaZE collapsed-chroma correction — #4123 / #4596

## Implementation and provenance

The implementation at `fcbeacb7e4abc86e4abb0594ea55d017191d2f04`
uses pipeline output version 24. Initial measurements used main
`3c4e4a25ff3f202b11d85ccd325b8219d888c781`; the branch was subsequently
rebased onto `00165b847c61ca9be94f0a98ef540144e8cb3826`. The intervening
main commits change panorama preview orchestration only. Rust pipeline,
comparison scripts and colour budgets are identical across the two bases.
The measured source revision is retained as `codex/pr4596-measured-v24`.

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

## Complete physical gate — executed, failing

The unfiltered harness completed through `tools/qualification/record.sh`,
with the pinned v24 CLI. The recorder confirmed the complete input corpus
hash before and after execution. `color_harness.json` records **796 executed
budget cases, 92 failed, zero skipped** (806 comparisons across the passes).

| Pass | Comparisons | Failures |
| --- | ---: | ---: |
| Neutral, down | 606 | 76 |
| Auto baselines | 20 | 0 |
| Full-resolution detail | 180 | 16 |

The neutral pass has 170 rows with only full-resolution references; all are
covered by the detail pass. There are no missing unique cases, render failures,
or comparison errors. Generated support registries now report the measured
failed evidence instead of missing evidence. This does not satisfy the merge gate.

Independent main controls now cover **all 92 failing cases**: every case also
fails on main, and every individual metric breached by the PR already breaches
on main. There are no newly failing cases or newly breached metrics in this
set. `amaze4596-complete-gate.json` preserves all 92 controls, canonical PR
results, and SHA-256 bindings for the RAWs, sidecars, references, candidate
images, main images and both CLI binaries. These controls are not a second
complete main run and do not turn the failing canonical record into a pass.

Early diagnostics of 136 rendered neutral cases found 17 budget breaches.
Independent renders of the exact main revision reproduce all 17 failures.
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

The original defect and both historical regression cases pass in the complete
run, but the complete colour gate fails. Do not infer physical qualification from
fixture-free CI success or from the focused improvements.

### Reporting failed evidence in CI

Publishing the full failed record exposed a code-generation error in clean
checkouts: the evidence loader tried to rehash the gitignored physical corpus
before it could report the failure. Explicitly failed records now remain failed
without installing their measured corpus. The recorded corpus hash and source
revision are preserved; the uncomputed current hash is null. Nonfailed records
still require complete current inputs and matching hashes before qualification.
All 28 capability-registry tests pass, including a real file-backed regression
that rejects a claimed pass when the physical manifest is absent.

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

### Completed Adobe tint captures

All 36 affected tint cases now have authentic full/down renders from Photoshop
27.11.0 / Camera Raw 18.7. Every one of the 72 PNGs passes the effective-settings
audit. Original RAW and canonical XMP hashes remain unchanged.

`amaze4596-adobe-tint-audit.json` records the authoring controls, completed
As Shot axis values, image dimensions, image/ICC/effective-XMP hashes, and
main-versus-PR comparisons against both original and corrected references.

The original tint references fail 18/36 cases on each code version; corrected
diagnostic references fail 17/36 on each. Eight old failures pass and seven
previously passing cases fail after reference correction. Neither comparison
set introduces a newly failing case on this PR relative to main. This shows
why replacing the canonical references cannot be treated as a passing gate.
The corrected captures remain diagnostic; canonical references and budgets
were not replaced or widened.
