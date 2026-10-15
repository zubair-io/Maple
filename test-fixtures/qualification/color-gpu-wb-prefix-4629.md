# GPU white-balance ordering and HueSatMap — #4629

## One-shot rendering correction

The physical Canon `test_0006.DNG` test failed CPU/GPU parity by 98 byte levels
at tint +150 (limit 2). Camera-space white balance precedes nonlinear DCP
HueSatMap and negative-channel handling on CPU. The old GPU preparation baked
As Shot white balance and auto exposure, then applied a post-DCP linear matrix.
That matrix cannot reproduce the CPU stage order or its WB-dependent exposure
statistic.

The one-shot renderer already develops a fresh CPU prefix for every call. Its
shared preparation helper now retains the requested temperature, tint, authored
flags, WB scale version and method. The existing develop performs WB, DCP and
auto exposure in their original order. The GPU tail receives identity WB to
avoid applying the adjustment twice. This adds no develop or upload to the
one-shot call. Persistent cached live sessions retain their separate entry point;
their pre-DCP GPU migration remains required under #4629.

The same physical test now stays within **one byte level** for all 12 cases:
Neutral with isolated processing, Neutral with normal processing defaults and
default Auto, each at baseline, tint ±150 and temperature 8500 K. Maximum changed
channel fraction is 0.00006768, below the unchanged 0.05 limit. The RAW bytes are
unchanged. Independent core tests also cover partial authored-WB flags, legacy
and current WB scales, both AE modes, and unchanged cached-prefix behavior.

## HueSatMap prerequisite and numerical defect

A standalone GPU pass implements the complete existing trilinear ProPhoto-D50
HueSatMap operation, including linear/sRGB table encoding, collapsed axes,
signed hue wrap, near-neutral fade, negative lift restoration and HDR/alpha
preservation. It borrows the resident profile data and uses the existing frame
resource pool. Same-sized repeated passes, including changed table contents,
allocate no new GPU resources after warming.

This pass is an explicitly staged prerequisite under #4629. It is not yet wired
into the persistent live chain. Camera-RGB preparation, DCP matrices, auto
exposure and the intervening processing must move together to preserve order.

Strict parity testing exposed a CPU numerical defect: weighted interpolation
could round a constant +180 or −180 degree hue past the signed wrap boundary.
The near-neutral fade then applies a rotation with the opposite sign. A new
independent constant-half-turn test fails the old implementation. Hue interpolation
now uses difference form, which preserves equal endpoints exactly; saturation
and value retain their existing arithmetic. The GPU uses the same operation.
The two existing HSV guard constants are single-sourced through codegen.

Pipeline output version **35** and Auto-fit model version **7** invalidate earlier
render and fit artifacts.

## Qualification

| Check                                                         | Result                                                        |
| ------------------------------------------------------------- | ------------------------------------------------------------- |
| Full raw-core library with GPU enabled                        | 2,821 passed; 100 existing fixture-gated ignores              |
| Full raw-gpu library on Metal                                 | 289 passed; five existing ignores                             |
| Full raw-wasm GPU-enabled native library                      | 72 passed; eight existing ignores                             |
| Full default raw-ffi library during initial HSM qualification | 258 passed; one existing ignore                               |
| Native raw-ffi GPU checks after test metadata correction      | 44 passed; five existing ignores                              |
| Explicit physical one-shot WB comparison                      | All 12 comparisons within one byte level                      |
| Synthetic GPU HSM comparison                                  | Worst absolute error 0.00002265, below unchanged 0.0001 limit |
| Actual HSM tables from the physical corpus                    | Both available tables pass; worst error 0.00000191            |
| Existing native physical live/refine WB regressions           | Four passed, zero ignored; retains each existing criterion    |
| Browser target compile                                        | Passed on pinned nightly with GPU, parallelism and AVIF       |
| Grey DCP integration                                          | Five passed                                                   |
| WGSL validation                                               | All 48 shader modules passed                                  |
| Final source/input identity audit                             | 32 changed sources and four physical RAWs unchanged           |

The native FFI GPU run initially failed four tests. Their CPU oracle used ISO 100
while the FFI parameters and direct-GPU comparator used ISO 0. The #4638 ISO
fallback repair made this input mismatch observable. A shared test-only ISO
constant aligns all three paths, including the Display-P3 and film helpers. All
44 checks then pass at their original numerical tolerances. No production NR
behavior changed in that correction. The original failing log is retained.

The frozen final CLI has SHA-256
`36cf33a25ab6070cef700c415449f6974db97edbc865a2c560b2c6545a5af9b5`.
Source patches, logs and identity records are retained in the task's
`hsm-gpu-stage-final`, `gpu-one-shot-wb-order` and `hsm-v35-physical` archives.
The selected canonical physical run covers 56 cases and 76 comparisons, including
all 20 Neutral and Auto baselines. It completed all 76 comparisons: 62 passed and 14 failed, with no missing or
skipped required cells. All 20 Auto baselines passed. The failures are the
inherited Sony Neutral baseline and 13 tint cases already failing in the frozen
v32 original-case inventory; no new failing case appeared. All 244 declared
physical input hashes remained unchanged. The gate correctly exits 1, and these
remaining failures are not waived.

The complete physical corpus, cached-live binding parity and complete editor
performance remain required before the overall color repair can merge. No RAW,
authored XMP, Adobe reference, numerical budget or required case changed in this
implementation.
