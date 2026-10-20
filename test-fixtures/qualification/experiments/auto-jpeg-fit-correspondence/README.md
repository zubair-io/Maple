# Auto fitting correspondences — #5000

Diagnostic scene matching across all 16 embedded-JPEG fixtures. These registration results are not physical color qualification. Sparse-observation probes cover 0005, 0011 and 0015. OpenCV is used only in offline probes; production uses bounded Rust affine optimization.

The registered observations train a color proposal. Native/display acceptance rows, comparator geometry, image output framing and fixed quality thresholds remain unchanged. Selection retains the existing paired artifact unless the registered candidate passes original guards and beats the existing artifact under those guards. Neutral AgX, pipeline output 37 and Auto fit version 7 are unchanged.

83 Auto unit tests pass; six existing fixture-dependent tests remain ignored here. Physical all-20 qualification and host/GPU/banding validation are pending for this checkpoint. Latest previously qualified full run remains 5 JPEG passes, 11 failures and four exact fallbacks. This is incremental work on draft #5003; no merge authorized.
