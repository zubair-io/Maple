# Protected fine LUT checkpoint — source 9ebc50a4c1

The complete physical suite has **9 JPEG passes, 7 failures, 4 exact no-preview Auto==Neutral fallbacks, 0 errors**. The full goal is incomplete; draft #5003 must not merge.

Test0010 newly passes, clearing three native/bias checks. No individual check becomes newly failing in any display, native or bias family. Only0009/0010 PNGs change; the other14 JPEG renders are byte-identical to91fa. Test0009 remains passing. All20 original RAW,16 embedded-reference,16 output and frozen executable/source hashes were verified. Diagnostic0010/0015 PNGs exactly match the physical run.

All100 Auto unit tests pass (6 existing ignored),8 real-RAW host/cache checks,7 GPU LUT parity checks and5 canonical test0000 ramps pass. Additional before/after diagnostics cover both changed fixtures: all four color ramps pass, and their decoded float32 neutral ramps exactly equal the previous checkpoint. Both prior and current neutral ramps fail the unchanged test0000 ceilings when applied to these other cameras; this existing cross-camera defect remains explicitly recorded. EXR encoded bytes differ despite exact decoded samples; acceptance uses decoded equality.

The rejected a431 version improved0010 but worsened gray flat runs/drift. Neutral-axis anchoring fixes that regression while retaining0010's image pass. No budget is changed. Pipeline37, fit7, NeutralAgX and original inputs remain fixed.

All16 new before/after/JPEG triplets were visually inspected. 0005,0015 and0017 still show appearance differences and remain failed. All seven remaining fixtures:0000,0003,0005,0006,0007,0015,0017. Details in all-fixtures.md and visual-review.json. Full-resolution synchronized viewer: external auto-jpeg-fine-neutral-anchors/gallery/index.html.

The extra0015 diagnostic rejects further fine proposals for regional/RGB degradation even when some absolute errors decrease. A subsequent diagnostic-only commit exports exact refinement coordinates and origin/final artifacts so offline experiments do not accidentally use the earlier coarse fit coordinates. It changes no image calculations; the frozen full physical proof here is specifically source9eb.

No remote-CI or completed-goal claim. Continue small measured pushes to draft5003; no merge, readying, main push, version bump, budget relaxation or main/rebase/CI chasing.
