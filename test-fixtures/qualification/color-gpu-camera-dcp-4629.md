# Camera white balance and DCP on GPU — #4629

## Scope and stage order

The new fused GPU pass performs camera-space user white balance, the resolved
camera-to-ProPhoto matrix, optional trilinear HueSatMap, the ProPhoto-to-Rec.2020
matrix and the CPU's uniform negative-channel lift. With no HSM, the matrices
are folded on the host exactly as in the CPU fast path. Highlights remain
unbounded and alpha is retained. The HSM arithmetic is shared with the existing
standalone GPU pass, rather than copied into a second shader.

`GpuCameraColorimetry` owns the resolved camera profile and slider frame once.
Each update resolves the existing authored-axis and legacy-scale semantics,
computes the same camera gains and target ForwardMatrix as CPU develop, and
borrows the resident HSM table. The Bradford branch and HSM interpolation remain
anchored at As Shot. RawlerFallback and legacy lossy LinearRaw retain their
existing downstream WB contract. Aesthetic LookTables are explicitly rejected;
production profile resolution already excludes them. ProfileToneCurve remains
excluded, matching CPU colorimetry.

The CPU refactor only extracts the existing matrix calculation into borrowed
helpers; it changes no arithmetic or processing order. No output-version bump
is needed for this stage because live callers have not switched to it.

This is an explicit prerequisite under #4629, **not a completed cached-live WB
repair**. Shipping live sessions still upload the post-DCP prefix. Camera-RGB
preparation, auto exposure and the intervening spatial operations must move
with the new stage before that boundary can change. Enabling only DCP would
omit processing or apply it in the wrong order. This change does not claim to
resolve any additional end-to-end photographic gate cell.

## Numerical coverage

The fused pass is compared against the actual CPU `wb_camera::apply` and
`dcp::apply_colorimetry`, including the as-shot shortcut, both partial-axis
intents, explicit defaults, V1/V5 sidecars, extreme temperatures/tints,
ForwardMatrix/Bradford dispatch, baked/unbaked input, linear/sRGB HSM, negative
camera samples and HDR. There are 512 input colors per variant:

- 300 synthetic calibration variants, including deliberate branch overrides.
- 100 variants using the resolved profiles from physical fixtures 0000, 0002,
  0006 and 0013. These use a synthetic color lattice with real calibration;
  they are not full-photo comparisons.
- 25 fallback variants that leave WB to the downstream stage.

All pass. The worst absolute error across the real calibrations is
**0.000025749207**, below the unchanged 0.0001 stage limit. The fallback worst
error is 0.0000000298. Synthetic calibration variants reach about 79 scene-linear
units; their worst absolute difference is 0.000118255615. The initial all-absolute
check caught that difference and its failing log is retained. The new HDR test
bounds error by `max(0.0001, 32 × f32::EPSILON × pixel magnitude)`, retaining the
absolute limit around display white while measuring f32 precision at large HDR
values. The physical-calibration test additionally requires absolute error below
0.0001. No pre-existing test tolerance, photographic budget or pixel value was
changed to accommodate this numerical case.

GPU tests also pin row-major matrix layout, gain-before-matrix ordering, the
no-HSM folded branch, malformed-table rejection, one terminal readback, alpha,
HDR preservation and reuse of pooled resources across changed gains and table
contents. Repeated warm passes allocate no additional GPU resources. This is
not a complete editor performance measurement.

## Domain qualification

| Check                                                           | Result                                  |
| --------------------------------------------------------------- | --------------------------------------- |
| Full raw-core with GPU                                          | 2,823 passed; 101 fixture-gated ignores |
| Explicit fused-DCP checks, including four physical calibrations | Three passed; zero ignored              |
| Full raw-gpu on Metal                                           | 292 passed; five existing ignores       |
| Explicit HSM checks including physical tables                   | Four passed; zero ignored               |
| Full raw-wasm with GPU                                          | 72 passed; eight existing ignores       |
| Native raw-ffi GPU checks                                       | 44 passed; five existing ignores        |
| Browser target with GPU, parallelism and AVIF                   | Passed on pinned nightly                |
| WGSL validation                                                 | All 49 modules passed                   |
| Changed-source and RAW identity audit                           | All recorded files unchanged            |
| Rust/shell formatting and file headroom                         | Passed                                  |

## Evidence

Source snapshots, the initial failing HDR check, subsequent parity results and
before/after source and RAW hashes are retained in the task's
`dcp-gpu-stage` archive. Existing HSM tests continue to compare directly with
raw-core, including the actual available corpus tables. The WGSL validator
assembles both consuming kernels with the same shared HSM body and generated
constants as the runtime; it validates that body through both real modules.

No RAW, sidecar, reference PNG, required case or color budget changed. The
complete physical corpus, cached-live binding parity and full editor performance
remain mandatory for the overall repair.
