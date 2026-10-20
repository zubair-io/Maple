# C2 common-highlight probe — not adopted

This experiment replaces the cubic common-highlight blend with the unique
quintic satisfying zero first and second derivatives at both endpoints.
It adds no fitted parameters and changes no budgets or original inputs.
`candidate.patch` records the exact four-file prototype against source commit
`2d8153f166c91a6b510e0f0b6227a93cd6a27734`; it is evidence, not applied production code.
The probe was built without output/cache version stamping and must not be
published as a production binary. Any later adoption needs version stamping
and fresh physical qualification.

## Focused results

All 52 relevant core AgX tests and 10 GPU parity tests pass. The new curvature
test fails against the original cubic as expected, demonstrating the different
endpoint property; that alone does not establish a physical-image defect.
The accompanying logs preserve those runs.

The canonical numerical comparisons on three failing current-main controls
clear **zero whole cases**. Daylight green bias changes from
0.033143953543420555 to 0.03224978669110967 (ceiling 0.0323); Nikon green bias
changes from 0.16167013038482758 to 0.16159238462698 (ceiling 0.1616).
Both green measurements pass, but remaining red/blue breaches keep those
cases failing. Pixel highlights red also remains above its ceiling.
All raw metrics are retained in `residual-results.json`.
Ten original input files and the frozen probe binary were rehashed afterward.

The probe was rejected: it clears zero of the three residual cases and
introduces a new physical failure in a previously passing retained control. Only its own four source diffs were reverted, after
checking they exactly matched the preserved patch. The complete main baseline
continues using its original frozen binary. Fourteen historically improved
controls were also rendered and compared: 9 pass, 5 breach, with no missing
inputs or comparison errors. All five candidate breaches were then compared against captured main. Four
already fail on main. `test_0007/texture_max` passes on main (max
42.827349428170635 <= 43.4), but fails the candidate (max
43.66641128697719 > 43.4). These matched controls therefore establish one
new whole-case failure. This is not a complete regression sweep. Twelve
original inputs and the frozen main binary were revalidated for that match. All 32 original
inputs used by the fourteen-case comparison were revalidated afterward.
