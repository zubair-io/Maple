# Rejected smooth-neutral feasibility probe

Offline only; no LUT or threshold change adopted. Starting from the rejecteda431 test0010 LUT, a99-variable nonlinear constrained solve adjusts33neutral RGB nodes, with monotonically increasing anchors, bounded drift, positive luma increments and a strict0.0038second-difference interior target. It converges in13iterations. A standalone Rust projection retains the original own-axis inequalities while fixing these alternative neutral anchors.

The computed neutral ramp meets the fixed second-difference ceiling (0.0038000074 versus0.004007), but the resulting LUT raises sampled display meanDE from the qualified9eb2.29679 to3.07825 and some regional means by2.66795. It is rejected. Improving a synthetic ramp does not qualify a photographic fix. Original9eb and rejecteda431 photo/ramp assessments are retained.

The offline interpolation evaluated the actual LUT directly; the existing auto-tail-ramp instrument additionally applied Auto2's identity ProfileCurve cache marker. This explains why the offline flat-run result did not reproduce that instrument's older flat-run result. Legacy identity curves still compress highlights1.0 to0.975. A separate production curve-presence fix8eff5491e1 now omits this marker at all artifact/render boundaries; its full qualification is pending. Do not treat the older instrument's curve-plus-LUT output as proof of LUT-only CPU parity.

Exact diagnostic exports for0000,0005,0017 were captured using the frozen6a binary and byte-match all three9ebphysical PNGs. They include refinement_native/refinement_display and fine origin/final artifacts for the next experiment. Full matrices/PNGs/binaries remain external; hashes in expanded-diagnostics.json.

No pipeline37/fit7 change, NeutralAgX change, reference modification, tolerance relaxation, merge or new passing-photo claim.
