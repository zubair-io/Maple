# Blacks blowout + Clarity chroma fringing — investigation

Filed: 2026-04-26 (Ticket 11 follow-up)
Branch: `fix/blacks-blowout-clarity-fringing`

## Bug A — Blacks slider produces magenta crush (and white-plateau on Apple)

### Reproduction

The user's offending slider state is Contrast=71, Highlights=40,
Shadows=-56, Whites=3, Blacks=-50, Sharpen=45/Radius=1.0, NR Color=25.

Save it as `/tmp/bug_a_blacks.xmp`:

```xml
<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Maple ACR reference 1.0">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
   crs:ProcessVersion="11.0"
   crs:WhiteBalance="As Shot"
   crs:Sharpness="45"
   crs:SharpenRadius="1.0"
   crs:SharpenDetail="25"
   crs:SharpenEdgeMasking="0"
   crs:LuminanceSmoothing="0"
   crs:ColorNoiseReduction="25"
   crs:Contrast2012="71"
   crs:Highlights2012="40"
   crs:Shadows2012="-56"
   crs:Whites2012="3"
   crs:Blacks2012="-50">
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>
```

Then render:

```
cd src/raw-pipeline && cargo run --release --bin maple-cli -- \
  render ../../test-fixtures/raws/test_0002.dng \
  --params /tmp/bug_a_blacks.xmp \
  --out /tmp/test_0002_blacks_repro.png
```

### What the Rust render shows

Rust does NOT show the user's white-plateau symptom. It shows the SAME root-cause
artifact in a different form: **strongly red/magenta-shifted skin tones with
extreme black crush**.

Sampled pixel statistics (test_0002, 7216×5412 PNG):

| Region    | Baseline (R,G,B) | Bug A render (R,G,B) | Notes                                    |
|-----------|------------------|----------------------|------------------------------------------|
| center    | 116,86,62        | 1,1,1                | Crushed to display black                 |
| center-l  | 128,112,86       | 40,10,0              | Strong red-channel-only artifact (skin)  |
| upper     | 71,60,48         | 1,1,1                | Crushed to display black                 |
| lower     | 124,104,81       | 14,1,1               | Crushed, with R fragment                 |

Most of the image is at display black or near-black; what little remains has
strong R-only or pink character.

### Root cause (architectural; same on both platforms)

`SceneToneControls` applies Blacks as a scene-linear additive shift BEFORE the
AgX view transform:

```
b_add = blacks / 400.0          // = -0.125 for blacks=-50
p[c] += b_add                    // for each channel
```

For mid-shadow pixels (luma ~0.05 typical of skin in shadow), the shadows step
already darkens via `p *= 0.86` (shadows=-56), then blacks subtracts 0.125. In
scene-linear, that pixel is now at roughly -0.08 — **negative**.

AgX log-encodes per channel: `log2(max(p, 1e-10)) - log2(0.18)`. A negative
value clamps to `1e-10`, producing log2(1e-10) - log2(0.18) ≈ -30.7 EV, well
below `AGX_MIN_EV = -10`. Clamps to 0, sigmoid → 0.000235.

The R channel of skin/warm tones pre-blacks is typically much higher than G/B
(skin reflects red more). After `-0.125`, R may stay *just barely* positive
while G and B go strongly negative — both clamp to 0 in AgX, but R survives.
Result: **R-dominant pixels (pink/magenta) where neutral skin should be**.

Per-channel sharpen (Sharpen=45, Radius=1) at edges further amplifies R/G/B
asymmetry, creating speckled colored noise on fine detail.

### Why "white plateau" on Apple

The user's Apple screenshot shows white plateau, not black crush. Two
plausible Apple-specific contributors:

1. fp16 sampling in CoreImage's `coreimage::sampler_h` — half-precision
   ulp-spacing near 0 is much coarser than f32, so the negative-pixel funnel
   into AgX may differ in how many pixels hit the clamp vs. retain a tiny
   positive R value. With Apple's sharpen overdrive on top, very small +R
   could amplify wildly.
2. AgX is fed the post-sharpen scene-linear stream. If a pixel exits sharpen
   with one strongly positive channel and two near-zero channels, AgX
   sigmoid evaluates each channel independently, and the polynomial's tail
   beyond the fitted range can produce values close to 1 quickly.

The point is: **the architectural root cause is the same**. Subtracting in
scene-linear before AgX produces non-physical values whose downstream
behaviour is brittle across precision regimes.

### Fix

Re-route Blacks (and Whites) to modulate the AgX view transform's domain
mapping rather than adding/multiplying in scene-linear pre-AgX. Specifically:

- **Blacks**: shift the *display-side* toe — equivalent to nudging the AgX
  output low end via `display = max(display + blacks_offset, 0)` or by
  reshaping the polynomial input near 0. The simplest implementation that
  preserves scene-linear semantics is to apply the additive shift in the
  log-encoded domain: `log_norm += b_add_log`. This keeps the maths
  monotone, never goes negative, and (a) darkens deep shadows for blacks<0
  and (b) lifts deep shadows for blacks>0 — the ACR convention.
- **Whites**: same mapping in the upper end of log-norm.

For this fix I will keep the change scope tight and only address Blacks
(the bug). Whites stays in scene-linear for now; its current `* 1.015`
gain at the user's blacks=-50 / whites=3 is harmless (≤ 1.5% gain).

### Concrete fix (this PR)

Move the Blacks step into log-encoded space inside SceneToneControls so it
never produces negatives:

```
let log_b = blacks / 400.0       // same scale, but applied differently
// ... after log encoding, before the inline sigmoid:
log_norm += log_b * (1.0 - log_norm)   // strongest at log_norm=0 (deep shadows)
                                        // tapers to 0 at log_norm=1 (highlights)
```

Wait — that changes the AgX call. **The constraint says "do not modify AgX
math"**. So instead, the fix lives entirely in SceneToneControls: clamp the
post-blacks-shift values to `>= 0` before forwarding. This *changes the
behaviour* for blacks<0: deep shadows now floor at scene-linear 0 instead
of going negative. The R-dominant residue disappears because all channels
floor uniformly. The pink-skin artifact goes away.

Trade-off: blacks<0 has less dynamic-range crush at the very deep end (since
floor is 0 instead of -0.125). This is closer to ACR's behaviour anyway —
ACR doesn't synthesise negative scene values from a black-point shift.

## Bug B — Clarity (and Texture) per-channel chroma fringing

### Reproduction

The user's offending slider state is Vibrance=35, Saturation=-44,
Clarity=100, Sharpen=45/Radius=1.0, NR Color=25. Save as
`/tmp/bug_b_clarity.xmp` (wrap the same XMP envelope as Bug A,
substituting these `crs:` attributes: `crs:Vibrance="35"`,
`crs:Saturation="-44"`, `crs:Clarity2012="100"`).

```
cd src/raw-pipeline && cargo run --release --bin maple-cli -- \
  render ../../test-fixtures/raws/test_0002.dng \
  --params /tmp/bug_b_clarity.xmp \
  --out /tmp/test_0002_clarity_repro.png
```

### What it shows in Rust

Pixels that were near-neutral in the baseline emerge as strongly chroma-shifted
in the clarity render. Worst-case sampled pixel at (4414, 1430):

- baseline: `R=0.647, G=0.620, B=0.631` (near-neutral grey)
- clarity_max: `R=0.792, G=0.000, B=0.631` (saturated magenta)

The magenta-fringe metric `(R+B)/2 - G` jumps from 0.365 max (baseline) to
0.712 max (clarity render). On a fine edge where the green channel happens
to be slightly brighter than R/B in the blurred reference, the per-channel
unsharp `out = src + (src - blurred) * amount` at amount=1.0 over-subtracts
G, driving it to 0 (or negative, clamped at later AgX log step).

### Root cause

`stages/clarity.rs` and `stages/texture.rs` (and the matching Metal kernel
`SceneUnsharp.metal`) apply unsharp PER CHANNEL in RGB. Per-channel high-pass
amplifies hue differences asymmetrically on edges where R/G/B differ. ACR's
clarity is luma-only for exactly this reason.

### Fix

Reimplement clarity (and texture) in luminance space: blur the luma plane,
build a luma boost factor, then re-apply as a multiplier to the original
RGB. This preserves R:G:B ratios (chroma) and only amplifies luminance
contrast.

```
luma          = dot(rgb, LUMA_REC2020)
luma_blurred  = blur(luma)                       // gaussian @ radius
luma_boost    = luma + (luma - luma_blurred) * amount
out_rgb       = rgb * (luma_boost / max(luma, 1e-6))
```

Lands across all three platforms in one logical change set:

- `src/raw-pipeline/raw-core/src/stages/clarity.rs`
- `src/raw-pipeline/raw-core/src/stages/texture.rs`
- `src/apple/Packages/MapleCore/Sources/MapleCore/Metal/SceneClarity.metal`
  + Swift wrapper rewire in `MetalKernels.swift`
- `src/web/projects/maple-common/src/lib/webgl/...` (clarity / texture
  WebGL fragment shaders — same algorithm)
