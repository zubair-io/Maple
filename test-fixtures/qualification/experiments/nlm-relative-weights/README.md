# Relative Gaussian NLM correctness prototype

Not adopted. The normalized reduction holds neighbor weights relative to the smallest exponent, rescales both sums when the minimum changes, and includes the max-neighbor center with weight1. This fixes the arbitrary center floor and avoids absolute-weight underflow.22 CPU NLM tests and23 GPU noise tests pass (2 existing benchmarks ignored). The new GPU analytic test fails the original shader (0.12896082 versus0.033333335), then passes the candidate with the same2e-6 bound. Extreme exponents32,128,1024 are checked in CPU general/tiled/dynamic and GPU paths. Existing f64 oracle center-floor policy changes to the actual Gaussian max-neighbor definition; its error bound is unchanged.

Seven actual source37 physical controls finish6pass/1known chart-temperature failure, with no clears and no new failures. The separate native-plus-relative experiment also leaves Panasonic exposure_min unchanged at7.985290853421119 versus7.90. Do not claim either as a physical-suite fix.

This is a scalar correctness prototype; optimized relative SIMD reduction has not been implemented or qualified. Original SIMD code was retained in the experiment. No shipping change, full-suite claim, input/reference/budget mutation or version bump. Pipeline version37.
