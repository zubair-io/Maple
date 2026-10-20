# Matched-coordinate proposal selection — #5000

Source `91fa556d44` corrects a mismatch: registered Auto proposals were trained
on corresponding scene points but judged against unregistered points. The
existing selected original proposal remains the control. A registered proposal
is now evaluated on corresponding native/display samples, using the same
registration. It must retain95% frame population and75% in every region, with
95% bidirectional geometric support and75% for each8-by-8 tile. Every existing
color guard, heldout split, prior projection and physical gate limit remains.
The fitter still produces the same shared LUT consumed by CPU and WGSL.

## Complete physical result

**8 JPEG passes /8 failures /4 exact Auto==Neutral fallbacks /0 errors.**
0012 now passes: mean/p95 CIEDE2000 are2.247/6.018. There are94 cleared
individual checks and zero added failures versus the coordinate-corrected
15d renderer. Clears:0012=69,0017=22,0007=3. 0017 mean/p95 improve to2.506/6.501;
all native band and signed-bias checks now pass, but seven regional checks at
the bottom corners remain red. This is one new fully passing image.

All16 before/after/JPEG triplets were inspected.0012 foreground and building
contrast are visibly closer to the camera JPEG;0017 wall/sky contrast improve
while grass/corners remain wrong.0005/0015 remain visibly wrong and fail.
Eleven JPEG PNGs remain byte-identical; five change. All20 RAW hashes,16 embedded
JPEG hashes,16 output hashes and frozen source/binary identities were verified.
Pilot0015 and0017 PNGs exactly match the full run. Pipeline37 and fit7 stay fixed.
Neutral AgX, renderer lens settings and original bytes are preserved.

Validation:95 Auto unit tests pass (six existing fixture tests ignored),8 real
RAW host/cache/parity tests,7 GPU LUT parity tests,5 fixed-budget banding ramps;
formatting and source headroom pass. Previous42 Python tests remain applicable:
Python gate source is unchanged from8c8c470982 and frozen hashes match.
Draft PR5003 remains unmerged; the full goal is incomplete.

## Rejected and diagnostic work

0015's registered proposal remains rejected. With corrected correspondence it
improves average/native errors, but worsens regions10,18,19,55 beyond the existing
regional safety margin. Its output remains byte-identical to15d. No guard was
removed to force acceptance.

The optimization folder preserves offline SciPy/HiGHS diagnostics on captured
0015 observations (training only, every fourth training row; heldout not fitted).
The full repeated-row coarse LP hit its90-second limit without a solution.
A sampled9-cube correction converged to worst normalized RGB group error2.4487;
a sampled independent existing33-cube LUT converged to2.2569. Both preserve
current passing group limits, [0,1] bounds, own-axis and gray-axis constraints.
The1e-7 allowance is float projection roundoff, never an image-quality budget.
The fine solution has constraint residual2.7e-13 and nodes in[0,1]. These sampled
model diagnostics are not image passes or proof that every possible processing
method fails. They show that simply increasing this global fit's capacity does
not satisfy the sampled0015 constraints; spatial contrast/camera processing
needs investigation. No LP artifact was adopted into the renderer.

External evidence: `5000/auto-jpeg-matched-selection/`, including both pilot
observation snapshots and all before/after images. LP arrays/logs/scripts are
in `5000/auto-jpeg-absolute-objective/`. The verified NAS checkpoint preserves
these large files. Next: diagnose and fix remaining0000,0003,0005,0006,0007,
0010,0015,0017 using the same entire-corpus gate; no merge or version bump.
