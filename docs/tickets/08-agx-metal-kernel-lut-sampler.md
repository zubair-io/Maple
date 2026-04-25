# AgX Metal kernel: LUT sampler returns 0 regardless of coord

## Context

After commit `1102c16` added the `[[stitchable]]` attribute to all CIKernel
entry points (which Apple's modern macOS CoreImage now requires), the
`AgXViewTransform.metal` kernel finally compiles and runs. But its output
on a mid-gray (0.18) input is `(0, 0, 0, 1)` — pure black.

Diagnostic via `/tmp/probe-lut-coord.swift` (committed as part of the
investigation): every `coreimage::sampler_h.sample(float2)` call on the
512×1 AgX LUT image returns 0.0, regardless of the coordinate passed
(tried `(0, 0)`, `(0.5, 0.5)`, `(256, 0.5)`, `(255.5, 0.5)`, `(511.5, 0.5)`).

The bare AgX kernel without LUT use (just log_encode + clamp) returns
correct values (`204` u8 for input `0.18`), confirming the `[[stitchable]]`
+ `sample_t` syntax is working — the LUT image binding / coord-space
mapping itself is the problem.

## Impact

`processSceneLinear` was producing all-zero output (entire image black
on screen) once the kernel actually ran. As a temporary unblock, the
AgX call has been bypassed — `processSceneLinear` returns the chain
output without view transform, giving a visible but un-tone-mapped
preview. Highlights clip; midtones look high-contrast.

This means the user sees raw scene-linear Rec.2020 data gamma-encoded
straight to sRGB by `CIContext.createCGImage(..., colorSpace: sRGB)` —
not what the spec mandates. **Restoring AgX requires fixing this
ticket.**

## Hypotheses

1. **CoreImage's default sampler transform for a 512×1 image fed into a
   larger destination clamps the LUT image to a tiny strip of destination
   space.** When the kernel calls `lut.sample(float2(256, 0.5))`, CoreImage
   may transform `(256, 0.5)` from destination-working-coord space through
   the LUT's internal transform — landing outside the LUT's effective
   region and falling to the clamp-to-edge or transparent default.
2. **DeviceGray colorspace doesn't survive the working-space conversion.**
   The LUT is built as `CGColorSpaceCreateDeviceGray()`. CoreImage may
   convert it to working space (`extendedLinearSRGB`) and the gray-to-RGB
   expansion may produce something that samples as zero.
3. **CIImage(cgImage: lutCg) discards LUT data on creation.** Less likely
   but possible — single-channel float CGImage may not survive CIImage
   wrapping.
4. **`coreimage::sampler.sample()` is treating the float2 arg as
   normalized [0,1] instead of pixel space.** This contradicts Apple
   docs but stitchable kernel semantics may differ.

## Proposal

Three independent paths, each independently shippable:

1. **Inline the AgX sigmoid in the Metal kernel.** Skip the LUT entirely:
   compute the sigmoid output mathematically per channel using the same
   coefficients (`AGX_BASE_SLOPE`, `AGX_MID_GRAY`, etc.) the Python script
   uses to bake the LUT. ~30 lines of Metal. Removes the LUT-binding
   dependency entirely and matches the WebGL2 plan's eventual approach.
2. **Switch the LUT to a 4-channel RGBA texture.** Replicate the gray
   value across all four channels; sample as `.r`. Tests whether single-
   channel DeviceGray is the issue.
3. **Use `samplerTransform` / explicit sampler coord scaling.** Pass the
   LUT image with a `CGAffineTransform` that maps `(t, 0.5)` in
   destination working coords to the right LUT pixel.

Recommend (1) — eliminates the failure mode, simplifies the kernel,
matches the eventual cross-platform shape.

## Acceptance criteria

- AgX kernel produces correct sigmoid output for a synthesized mid-gray
  input (validated via existing parity infrastructure).
- The temporary `withNRColor` return in `processSceneLinear` is replaced
  with the original `MetalKernels.applyAgXViewTransform(...)` call.
- The `MapleApp.init` AgX kernel-load assertion is restored.
- Visual smoke test on the 100MP reference fixture: midtones, highlights,
  shadows look identical to the Rust CLI render of the same fixture.
- Existing parity harness shows no regression (the LinearRaw fixtures
  remain skipped per ticket #07).

## Pointers

- `src/apple/Packages/MapleCore/Sources/MapleCore/Metal/AgXViewTransform.metal:31`
  — current LUT sample formula (broken).
- `src/apple/Packages/MapleCore/Sources/MapleCore/Metal/AgXViewTransform.metal:44`
  — kernel entry, `sample_t` form.
- `src/apple/Packages/MapleCore/Sources/MapleCore/MetalKernels.swift` —
  `agxLUTImage()` builds the LUT CIImage.
- `src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift`
  ~line 425 — temporary AgX bypass returning `withNRColor`.
- `src/apple/Maple/MapleApp.swift:17-25` — disabled launch-time assert.
- `src/raw-pipeline/raw-core/src/view/agx.rs:50-77` — Rust LUT sampling
  reference (the source of truth the Metal kernel must match).
- `src/scripts/derive_agx_lut.py` — the script that bakes the LUT;
  contains the closed-form sigmoid coefficients used in option (1).

## Notes / risks

- Inlining the sigmoid (option 1) matches Rust's reference implementation
  exactly only if the LUT entries themselves match the closed-form
  evaluated at the LUT's discrete x positions. The LUT was baked from
  Blender's polynomial which is a piecewise approximation — the inline
  form may have small numerical differences. Validate via parity test.
- The `1102c16` `[[stitchable]]` change is correct and stays.
- The `728188c` `sample_lut` `float()` cast change is correct and stays.
- The `24f5d56` + `d3f7db0` `float4(...)` casts on `sample()` returns are
  correct and stay.

## Estimated impact

Restores AgX tone mapping on the new path → restores correct visual
output for the entire editor. Without this fix, the user sees clipped
highlights and elevated midtones on every RAW.
