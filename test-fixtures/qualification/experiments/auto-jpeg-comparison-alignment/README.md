# Approved comparison-coordinate alignment — #5000

The user chose to retain renderer lens corrections and align comparison
coordinates. Harness source `8c8c470982` preserves the fixed external color/detail
policy. The renderer remains `15d26545dd`, output version37 and fit version7.
One structural affine reference transform serves both native/display checks;
only geometric non-overlap is masked. Candidate pixels are neither fitted nor
resampled. Bidirectional overlap must be at least95%, with at least75% in every
8-by-8 tile. Failed structural confidence or overlap fails qualification.

`regrade.json` re-evaluates all16 original physical PNG pairs using frozen Python
sources. All20 original RAW hashes, all16 candidate/reference hashes and the CLI
hash were reverified. All4 previewless output pairs were checked again for exact
RGB equality. This is a full frozen-output regrade, not a fresh RAW render.

Results: **7 passing /9 failing /4 exact fallbacks**. The previous unaligned run
was5/11/4. Newly passing0008 and0011 reflect corrected measurement coordinates;
**no rendered color changed and no new color fix is claimed**. Remaining failures
are0000,0003,0005,0006,0007,0010,0012,0015,0017. Original unaligned scores and
historical photographic labels are preserved. All28 remaining historical bad
photographs and all48 deliberate photographic cast/flat/checkerboard damages
across all16 references are rejected. There are38 passing Auto Python tests
plus4 passing wrapper tests; Ruff and budget headroom pass.

All16 reference/aligned-reference/candidate triplets were inspected. The obvious
contrast defects in0005/0015/0017 remain failures. The full active goal is not
complete. Next: fix real appearance errors using these matched scene points,
then repeat full physical/color/host/GPU/banding qualification without changing
tolerances or versions. Draft PR5003 must remain unmerged.

Large images and frozen scripts are under the external5000 evidence directory
`auto-jpeg-comparison-alignment/`; source physical PNGs remain in the prior
`auto-jpeg-quality-budget/full-suite/`. The NAS copy preserves these as separate
checkpoints. No original RAW or JPEG/reference bytes are modified.
