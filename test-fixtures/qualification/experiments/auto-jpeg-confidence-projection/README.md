# Preserve supported colors in LUT projection — #5000

Cached aligned fixture0005 isolates a projection fault. Reconstructing the pre-projection33-cube from Rust's own saved9-cube correction improves sampled display meanDE3.84494→2.68386, p959.97059→9.90785 and every one of64regions(max change−0.13199). Uniform node-distance projection then worsens some regions by3.50DE. This is not a solver-convergence problem; a finer17-grid probe offers only modest additional gain. These cached calculations are diagnostics, never physical passes.

Weight each node's constrained projection by its native training-pixel normal-matrix diagonal plus the existing1e-8 prior floor. Unsupported gamut nodes no longer displace observed colors equally. Pairwise projection handles unit bounds exactly. The same prior-relative axis and gray minimum differences are retained. A reverse feasible upper envelope and forward closure on the acyclic constraint graph complete every inequality after the iterative projection, instead of assuming32cycles converged. No constraint or independent image-quality budget is relaxed.

Independent tests preserve a supported node unless the actual unchanged bound requires moving it, exercise saturation at1.0 without numerical stalling, and verify every axis/gray edge and unit bound on an uneven-confidence cube. Existing zero-residual, already-correct-channel, sampling, local-damage, backtracking and display-scale checks also pass:17focused tests. Native physical all-corpus qualification follows. Output37, fit7,33-cube format, source inputs, Neutral AgX, comparison coordinates and all fixed quality/banding limits remain unchanged.

## Complete physical result — still unaccepted

Frozen renderer f297e3b1f7: 5 JPEG passes (0002,0004,0009,0013,0014), 11 failures, 4 exact Auto==Neutral no-preview fallback passes, 0 errors. All16 original/candidate/JPEG comparisons were visually inspected. 0005's sky and container colors improve; 0015 remains too flat and 0017 remains faded. They remain failures. No passing labels were added.

Compared every strong-quality subcheck against the clean ed6424ae59 checkpoint: the prior17 new breaches in0007/0011/0015 are gone, but0005 has6 newly failing subchecks. Against the immediately preceding2ff checkpoint there are also1new in0008 and4new in0012. Mean error improvements do not waive any of these. `matched-subchecks.json` preserves both comparisons. The complete branch remains unaccepted.

68 Auto tests (6existing ignored),8real-RAW host/cache tests,7GPU LUT parity checks and all5unchanged-budget banding ramps pass. The separate33Python harness tests pass. These checks do not override physical failures. Subsequent display-training changes are qualified under their own source/hash and do not retroactively change this result.
