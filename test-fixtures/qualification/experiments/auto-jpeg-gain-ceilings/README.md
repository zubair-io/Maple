# Sensor gain-aware highlight detection — #5000

OpcodeList2 flat-field gains precede demosaic. The original highlight detector nevertheless used uniform sensor ceilings, falsely classifying bright gain-corrected values as saturated. Detection/ripple thresholds and scene-prior eligibility now scale with the same spatial gains. CFA samples retain their own phase; reconstructed channels interpolate the calibration; Preview uses the actual half-resolution Bayer quad. Full, sized, tile/frame-prior and pano prefix entries all share the correction. Known image channels are never divided/re-multiplied or modified by this calibration. RAWs without these maps retain the original arithmetic.

Independent synthetic tests demonstrate that the old detector changes unsaturated gain-corrected pixels, while the new detector leaves every byte unchanged; genuine partial saturation still reconstructs its missing channel and preserves both known channels. A nonconstant gain map and real clipped block exercise full-vs-tile parity at unchanged1e-4, including full-frame guided evidence. Existing44 highlight tests pass; sensor-map filter6passes includes five sensor tests and the new tile test.

A derived conservative minimum gain skips lattice evaluation for pixels that cannot be saturated. Existing stage-dump diagnostics can record false/missed hard-clip counts without a new runtime setting. Physical all-corpus qualification follows; unit passes do not establish color completion. Neutral AgX, output37, fit7 and image-quality limits stay unchanged.

The full, sized and pano entries now share the four-argument sensor-recovery helper, including the sized path's actual early-downsample divisor. This also keeps their source files below the570-line headroom gate. The tile entry retains its frame anchor and absolute sensor origin. The post-refactor native tile parity test passes. Physical qualification remains pending.

## Complete physical checkpoint

Source2ff187bacb: 5 JPEG passes(0002,0004,0009,0013,0014),11 failures,4 exact missing-preview Auto==Neutral fallbacks,0 errors. Four previously failing cases clear versus the original strong-quality baseline1pass/15fail. All16 before/current/reference images inspected. Remaining failures and new subcheck breaches(15in0015,1in0007,1in0011 versus ed6424ae59) stay explicitly unaccepted; the full goal remains incomplete.

65 Auto unit tests pass(6 existing ignored),8 real Pixel6Pro RAW host/cache checks pass,7 GPU LUT parity checks pass, all5 unchanged-budget banding ramps pass. Local headroom check passes. The physical0015 diagnostic confirms3,872 channel samples were falsely classified as hard-clipped by the old uniform detector; gain-aware detection finds624 genuinely clipped pixels versus4,476 previously, with0 newly missed hard-clip channels. This fixes a real sensor-processing fault but does not by itself fix the remaining image-quality failures.
