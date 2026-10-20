# Color targets and failure attribution — #5000

Production remains source `95fc03d6819b34f46f928ba93de58188a4014022`, output37,
Auto fit7. User explicitly requires Neutral's AgX appearance to remain.

The committed `color-suite-5000-target-triage.json` accounts for all105 breaches
in the last full806-comparison run, without changing a pass status or budget:

| Evidence category | Cases | Meaning |
| --- | ---: | --- |
| Confirmed reference-setting defect | 18 | Tint PNG effective settings disagree with intended sidecars. Independent Adobe recaptures exist; adoption is pending. |
| Introduced regression needing root cause | 13 | Captured main passes and current processing fails. Do not dismiss these as expected AgX. |
| Baseline appearance/calibration candidate | 56 | 33 native detail cases inherit all breached bias limits from their unedited source37 baseline; 23 other Sony cases need the baseline decode/calibration and appearance investigation. This does not prove AgX is the cause. |
| Unresolved processing or appearance | 18 | Needs independent stage or baseline-relative edit evidence. |

**Zero entire failing cases have been proven to be solely expected AgX.**
This is an evidence classification, not a waiver or a claim of105 actual
processing bugs. The native baseline means were freshly measured from all
pixels of current source37 renders, with candidate/reference hashes verified,
not copied from captured-main attribution. The driver reproduces the audit:

```sh
python3 test-fixtures/qualification/experiments/target-contract-audit/driver.py \
  --repo . --suite /path/to/branch37-full-suite --output /tmp/target-triage.json
```

Auto's accuracy target is the embedded camera JPEG. Its ACR regression pass
is a separate target. The repaired embedded-JPEG runner fails on render errors,
empty selection and no measurable bands, covers RAW extensions the old glob
omitted, and preserves per-fixture results. All nine runner contract checks and all12 existing ACR harness tests pass.
A fresh20-fixture physical run completed using the frozen production37
binary, default Auto rendering, original immutable RAW snapshots and unchanged
0.05 bias limit: **4pass,12fail,4no-preview,0errors**. These are16actual
comparisons, not20passes. The failed fixture IDs are0000,0005,0006,0007,0008,
0010,0011,0012,0013,0014,0015,0017. They require Auto/preview/geometry diagnosis;
they are not counted as105Neutral ACR failures. Full per-band metrics, input/
output/binary hashes are in `color-suite-5000-auto-embedded-jpeg.json`. Geometry retains
the pre-existing center-crop/BOX/inner80% protocol; geometric mismatch remains a
possible contributor to a measured failure, so a breach is not automatically
an Auto-fit root-cause diagnosis.

No AgX changes, pipeline-version bump, tolerance increase, original-input
replacement, merge or new whole-suite passing claim is made.
