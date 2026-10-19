# Fit Auto color at the comparison display scale — #5000

The paired fitter still minimized native JPEG-resolution residuals, despite selecting candidates and measuring perceptual quality after BOX reduction to a 1024-pixel long edge. Camera sharpening and native demosaic differences can bias that color objective. Train the same bounded, regularized residual using the existing display observation operator. The native held-out absolute/squared RGB checks, display mean/tail/local guards, fixed external quality limits and all banding limits remain unchanged. The same training/validation split is used at each scale. Preview sizes at or below 1024 retain their existing native path.

A cached aligned 0005 diagnostic improves display mean DE from 3.84494 to 2.58271, compared with 2.68386 for the native-trained unprojected residual. All 64 sampled regions improve and native RGB absolute errors also improve. Both calculations precede monotonic projection; neither is a physical passing result. The new independent physical run determines acceptance. Do not change geometry, source files, Neutral AgX, pipeline version 37 or fit version 7. Keep PR #5003 draft and unmerged.

## Full physical checkpoint — not accepted

Source57935f3ba0:5 JPEG passes,11failures,4exact Auto==Neutral missing-preview fallback passes,0errors. Passing0002/0004/0009/0013/0014. 0005meanDE improves3.867→2.633 and p95DE10.042→9.980. It still fails other fixed checks and introduces4new strong subcheck breaches versus ed6424ae59: R/G p95absolute errors and R/G region(2,0)mean absolute errors. Every other image introduces no new strong subcheck breach versus that checkpoint. Full branch remains unaccepted.

68Auto tests(sixexistingignored),8realRAW host/cache,7GPU LUT parity and all5unchanged-budget banding ramps pass. Unit passes do not override image failures. Current follow-up adds RGB tail and regional protection to candidate selection, retaining the same external limits.

The cached0015global capacity probe is diagnostic only: display meanDE8.7051→6.4092 with9grid and6.2769 with17grid; tailremains>21, before monotonic constraints. Increasing LUT resolution alone does not resolve that image. Preserve it as a failed lead; do not call a physical pass.
