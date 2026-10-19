# Auto JPEG band-calibration candidate — #5000

The structured Auto fit misses the per-reference-luma-band RGB objective on all
12known failures. This candidate adds a final monotone per-channel correction
fitted on the structured LUT's native-pixel outputs before footprint averaging.
It composes the correction into that same LUT; CPU/GPU artifact layouts and
Neutral's AgX transform remain unchanged. No second native RGB frame is copied.
The legacy display-fit API delegates to an identity transform, preserving its
calculation order. Design-matrix construction is extracted from the nearly-full
solve.rs without changing its sampling protocol or numerical tolerances.

52Auto-profile unit checks pass;6existing fixture-dependent checks are ignored.
The new deterministic contrast witness checks the corrected residual and
unchanged source pixels. The physical pilot is running against all4existing
passingJPEG controls and4known failures (0017,0015,0012,0010). No passing
physical case or whole-suite improvement is claimed at this start checkpoint.
Relevant host/GPU parity and physical results remain prerequisites for adoption.
Pipeline output37/fit7, JPEG limit0.05, original RAW/preview inputs unchanged.
Same draft5003, no merge. This is an incremental implementation checkpoint.
