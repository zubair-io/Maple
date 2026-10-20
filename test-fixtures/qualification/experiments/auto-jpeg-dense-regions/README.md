# Dense display-region selection experiment — #5000

Source `1f654b2f83af48a91ff063a14e5090343b9b94a9`. Full physical run: 2 JPEG passes, 14 failures, 4 missing-preview fallbacks verified equal to Neutral, zero errors. Every one of the original twelve bias failures remains failing. This is a checkpoint, not qualification or completion. The newly passing strong-quality case is test_0004; test_0002 remains passing.

Selection uses every sampled display observation for local safety, while retaining the native held-out RGB and perceptual checks. No image-acceptance budget changed. All original inputs and version 37 / fit version 7 retained. Full render evidence remains external under `auto-jpeg-dense-regions/full-suite`.
