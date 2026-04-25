# Color harness — catastrophic bias investigation (test_0006, test_0013)

Read-only diagnostic. No source files were modified.

## Summary

- The two catastrophic-bias fixtures in `src/scripts/test_color_pipeline.sh`
  (`test_0006.DNG`, `test_0013.DNG`) are **DNG-converter-produced "linear DNG"
  files** — `PhotometricInterpretation = LinearRaw (34892)`, `SamplesPerPixel = 3`,
  i.e. the file already carries demosaiced, white-balanced RGB.
- All other top-level DNGs in `test-fixtures/raws/` are
  `PhotometricInterpretation = ColorFilterArray (32803)` (genuine Bayer mosaics).
- `src/raw-pipeline/raw-core/src/decode.rs:130-136` has a `TODO` comment that
  says LinearRaw is not handled and falls back to a fake `RGGB` CFA pattern.
  That fallback then runs the data through `linearize → demosaic → DCP →
  AsShotNeutral` as if it were a Bayer mosaic. The result is data corruption
  (samples interleave wrong, then a second WB+matrix is applied on top of the
  one already baked into the file).
- **Root cause**: a real Maple bug — the LinearRaw decode path is unimplemented.
- **Recommendation**: drop these two fixtures from the parity gate until
  `decode::LinearRaw` is implemented properly. They are not signal about the
  AgX or DCP stages; they are noise from the un-handled photometric branch.

## 1. Per-fixture metadata

Source: `exiftool <raw>` on each file, captured to `/tmp/test_*_meta.txt`.

| Field                       | test_0006 (catastrophic)         | test_0013 (catastrophic)      | test_0007 (good)                 | test_0017 (good)        |
| --------------------------- | -------------------------------- | ----------------------------- | -------------------------------- | ----------------------- |
| Make / Model                | Canon EOS 5D Mark III            | Apple iPhone 12 Pro           | Canon EOS 5D Mark III            | Leica M10               |
| Photometric Interpretation  | **Linear Raw**                   | **Linear Raw**                | Color Filter Array               | Color Filter Array      |
| Bits Per Sample             | **8 8 8** (interleaved RGB)      | **12 12 12** (interleaved RGB)| 16 (mosaic)                      | 16 (mosaic)             |
| Samples Per Pixel           | **3**                            | **3**                         | 1                                | 1                       |
| Compression                 | Lossy JPEG                       | JPEG                          | Uncompressed                     | JPEG (lossless)         |
| Black Level                 | 0 0 0                            | 0 0 0                         | 2047 2047 2047 2048              | 0                       |
| White Level                 | 255 255 255                      | 65535 65535 65535             | 15000                            | 15000                   |
| ISO                         | 200                              | 32                            | 200                              | 100                     |
| Exposure Time / Aperture    | 1/125 / f/2.8                    | 1/5556 / f/1.6                | 1/125 / f/2.8                    | 1/45 / f/5.6            |
| As-Shot Neutral             | 0.606 / 1 / 0.462                | 0.449 / 1 / 0.541             | 0.606 / 1 / 0.462                | 0.485 / 1 / 0.805       |
| Color Temp As Shot          | 3653 K                           | 5358 K                        | 3653 K                           | 5200 K                  |
| Software                    | Adobe DNG Converter 9.8 (Win)    | iOS 14.3                      | Adobe DNG Converter 9.8 (Win)    | Leica camera 1.9.4.0    |
| Notes                       | Converted from CR2 in linear DNG mode | iOS HDR DNG with `LinearizationTable` + `ProfileGainTableMap` + semantic-segmentation aux | Same shot as 0006 but converted as full-CFA DNG | Native CFA DNG       |

`exiftool` survey of every top-level DNG fixture (`test_0000`, `_0002`, `_0007`,
`_0015`, `_0017`, plus the two suspects):

```
test_0000.DNG: Color Filter Array | bits=16
test_0002.dng: Color Filter Array | bits=16
test_0006.DNG: Linear Raw         | bits=8 8 8     <-- catastrophic
test_0007.DNG: Color Filter Array | bits=16
test_0013.DNG: Linear Raw         | bits=12 12 12  <-- catastrophic
test_0015.dng: Color Filter Array | bits=16
test_0017.dng: Color Filter Array | bits=16
```

The two catastrophic-bias fixtures are exactly the two `LinearRaw` fixtures. No
other fixture in the harness has `SamplesPerPixel=3`. The structural-only
mismatches (test_0007 ΔE 9.5, test_0017 ΔE 8.7) are different scenes through the
genuine CFA path — those are AgX-vs-camera-JPEG tone-mapping divergence, the
expected baseline.

The test_0006 / test_0007 pair is striking in particular: **both are converted
from the same Canon CR2 source** (`Original Raw File Name: 5G4A9394.CR2`,
identical `As Shot Neutral`, identical body). test_0007 is the lossless DNG
conversion (CFA preserved); test_0006 is the linear-DNG conversion of the same
shot (CFA collapsed into demosaiced 8-bit RGB). Same scene, same camera, same
WB, same illuminant. The only difference is which DNG mode the converter wrote.
That isolates the bias to the `LinearRaw` decode path.

## 2. Reproduced ΔE numbers

Workflow: extract embedded JPEG via `dd` at `PreviewImageStart/Length`, render
candidate via `maple-cli render`, resize candidate to the reference's
dimensions with PIL Lanczos, diff via `compare_images.py`. Same procedure as
`test_color_pipeline.sh`; outputs land in `/tmp/maple-investigation/`.

| Fixture   | mean ΔE₀₀ | P95   | max   | bias (R, G, B)              |
| --------- | --------: | ----: | ----: | --------------------------- |
| test_0006 | **50.34** | 70.34 | 82.61 | (+0.416, +0.222, **+0.694**) |
| test_0013 | **36.58** | 58.40 | 90.10 | (+0.292, −0.063, +0.151)    |
| test_0007 |      9.47 | 35.34 | 95.45 | (+0.017, +0.020, +0.017)    |
| test_0017 |      8.67 | 20.67 | 88.00 | (+0.037, +0.016, +0.025)    |

Numbers reproduce exactly the failures reported by the harness in the brief.
The "good" fixtures' bias triple is sub-0.04 across all channels; the bad
fixtures' bias triple is one to two orders of magnitude larger.

For `test_0013` the candidate is also 90° rotated relative to the reference
JPEG (DNG `Orientation: Rotate 90 CW` is honored in the embedded preview but
not in the candidate render). Rotating the candidate before the diff barely
moves the numbers (mean ΔE₀₀ = 35.88 / 38.77 for the two rotation senses, vs.
the orientation-mismatched 36.58). **The bias is real, not orientation noise.**

## 3. Visual inspection

Side-by-side renders at thumbnail scale — both written under
`/tmp/maple-investigation/test_*.candidate.thumb.png` and `*.preview.thumb.png`.

- **test_0006** — *bathroom scene with hairdryer wall mount.* The reference
  preview shows a correctly-tungsten-balanced bathroom interior (warm beige
  walls, black hairdryer cable). The Maple candidate is a near-uniform
  saturated **magenta/pink wash**: scene mean RGB (0.976, 0.650, 0.990) vs.
  reference (0.561, 0.429, 0.295). Luma is 0.756 vs. 0.455 — Maple is about
  1 EV brighter and dramatically blue + red biased, with G crushed. Structure is
  faintly visible through the cast.

- **test_0013** — *iPhone landscape: blue sky, distant trees, foreground grass.*
  Reference is a clear blue-sky landscape with green-brown winter foliage. Maple
  candidate is a **magenta/pink wash** with the hill silhouette barely
  discernible: candidate mean RGB (0.750, 0.439, 0.705) vs. reference (0.459,
  0.502, 0.553). Same magenta cast as test_0006 — consistent fingerprint of the
  bug (see §5).

Both candidates clip into red and blue channels across most of the frame.
Neither shows the per-frame structure of the source. This is not "AgX vs Apple
JPEG tone-mapping disagreement" — this is a colorimetric disaster. A
photographer would reject either output as broken before considering parity.

## 4. Stage trace (test_0006 → DCP)

Running `cargo run --release -p raw-core --example dump_pixel -- <raw> <x> <y>`
(per `CLAUDE.md` § "Diagnostic examples" — the `dump_pixel` example covers what
the brief's `stage-trace` reference describes).

### test_0006 (LinearRaw, bug fixture)

```
file:    .../test_0006.DNG
dims:    5760×3840
camera:  Canon EOS 5D Mark III
black:   [0,0,0,0]   white: 255           <-- 8-bit literal
WB:      [0.606, 1.0, 0.462]               <-- low-CCT (3700K) AsShotNeutral
BE:      +0.250 EV
scene_white_xyz: [0.995, 1.0, 0.510]        <-- low Z = warm illuminant

(2880, 1920):                              -- mid-frame, near-neutral patch
  raw count:                       65 (CFA channel 0 = R)
  camera-native (post-demosaic):   (0.255, 0.284, 0.304)   roughly neutral gray
  camera-native (post-BE):         (0.303, 0.338, 0.361)
  scene-linear Rec.2020 (post-DCP):(0.580, 0.218, 1.126)   B = 5× G, way out of gamut

(1000, 1000):
  raw count:                       117 (CFA channel 0 = R)
  camera-native (post-demosaic):   (0.459, 0.344, 0.245)   warm gray
  camera-native (post-BE):         (0.546, 0.409, 0.291)
  scene-linear (post-DCP):         (1.082, 0.319, 0.840)   R and B both clipped, G crushed

(4500, 3500):
  raw count:                       66 (CFA channel 0 = R)
  camera-native (post-demosaic):   (0.259, 0.210, 0.172)   warm gray
  camera-native (post-BE):         (0.308, 0.249, 0.204)
  scene-linear (post-DCP):         (0.607, 0.183, 0.607)   R = B = 3× G, magenta cast
```

### test_0007 (genuine CFA, good fixture, same shot via different DNG mode)

```
black:   [2047,2047,2047,2048]   white: 15000
WB:      [0.606, 1.0, 0.462]                <-- identical to test_0006
BE:      +0.250 EV                          <-- identical
scene_white_xyz: [0.995, 1.0, 0.510]         <-- identical (same DCP, same illuminant)

(2880, 1920):
  raw count:                        3144  (CFA channel 0)
  camera-native (post-demosaic):    (0.085, 0.105, 0.036)    warm gray, low-key tones
  camera-native (post-BE):          (0.101, 0.125, 0.042)
  scene-linear (post-DCP):          (0.191, 0.142, 0.083)    R > G > B, warm — correct
  scene-linear luma:                0.151 (mid-gray = 0.18)
```

### What the trace says

Pre-DCP, the test_0006 camera-native RGB is roughly *neutral* (R ≈ G ≈ B for a
gray patch) — that is the visible signature of WB being **already baked in**
before Maple sees the data, because the linear-DNG converter applied the
camera's AsShotNeutral when it wrote the file.

Maple then applies AsShotNeutral *a second time* via `dcp::profile_for` (which
computes `inv(CM) · AsShotNeutral = scene_white_xyz` and uses that as the input
white for the DCP/forward-matrix chain). The second WB is not mathematically
the inverse of the bake-in — `AsShotNeutral` is a camera reading on a
neutral patch, and applying it through the DCP scene-white pipeline assumes
the input data is in *raw camera-native space*. When the input is already
white-balanced + matrixed RGB, you get a near-affine garbage transform: low-CCT
white-balanced RGB pushed *again* through a low-CCT correction → over-warm pre-
matrix data → over-shifted post-matrix RGB. That over-shift is exactly what
the post-DCP triples show: B going from input ≈ 0.30 to output ≈ 1.13 (factor
3.7×) on a near-neutral pixel.

The **same-pixel, same-scene, same-WB** comparison against test_0007 (where
the data really is raw Bayer pre-WB) shows the DCP path does the right thing
with the right inputs: post-DCP (0.191, 0.142, 0.083), close to 18% mid-gray
luma, slight warm cast appropriate to a 3700K interior.

So the DCP and AgX stages are not the problem. The problem is upstream of
them: `LinearRaw` data is being fed into the Bayer-mosaic pipeline.

## 5. Mechanism of the corruption

`src/raw-pipeline/raw-core/src/decode.rs` lines 126–140:

```rust
let cfa = match &raw.photometric {
    RawPhotometricInterpretation::Cfa(cfg) => map_cfa_pattern(&cfg.cfa.name)?,
    RawPhotometricInterpretation::LinearRaw => {
        // TODO(slice-4+): LinearRaw DNGs carry already-demosaiced RGB data and may
        // not have a meaningful CFA pattern. Defaulting to RGGB is conservative —
        // slice-1 fixtures don't trigger this path. Revisit when a LinearRaw
        // fixture is added.
        CfaPattern::Rggb
    }
    RawPhotometricInterpretation::BlackIsZero => {
        return Err(Error::UnsupportedCfa("BlackIsZero (monochrome)".to_string()));
    }
};
```

The TODO is the bug. The `BlackIsZero` arm rejects with an error. The
`LinearRaw` arm silently proceeds with a *fake* RGGB CFA pattern. Two fixtures
in the suite (test_0006, test_0013) hit this path; the comment says "slice-1
fixtures don't trigger this path" but they do.

What rawler hands us for a 3-SPP LinearRaw image (rawler 0.7.2,
`decoders/dng.rs:71`):

```rust
RawImage::new_with_data(cam, raw_data, width * cpp, height, cpp,
                        wb_coeffs, photometric, blacklevel, whitelevel, dummy);
```

`raw_data` is interleaved RGB samples in scanline order: `[R₀ G₀ B₀ R₁ G₁ B₁
…]` per row, length `3 · 5760 · 3840 = 66_355_200` u16 samples for test_0006.

What Maple's `linearize::sensor_linearize` does
(`src/raw-pipeline/raw-core/src/linearize.rs:8-30`):

```rust
img.pixels.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
    let raw_row = &raw.raw_data[y * w..(y + 1) * w];   // <-- assumes 1 sample/pixel
    for (x, px) in row.iter_mut().enumerate() {
        ...
        let color = raw.cfa.color_at(x as u32, y as u32) as usize;
        px[color] = v;                                  // <-- one channel per coord
    }
});
```

`w = 5760`, but the actual scanline is `3 · 5760` long. So the loop reads only
the **first 5760 samples of the first row**, treats them as one-sample-per-
pixel Bayer, and CFA-routes them through `RGGB`:

- column 0 (RGGB R): reads raw_data[0] = R₀ → routed to channel 0 ✓ (R)
- column 1 (RGGB G): reads raw_data[1] = G₀ → routed to channel 1 ✓ (G)
- column 2 (RGGB R): reads raw_data[2] = B₀ → routed to **channel 0 (R)** ✗
- column 3 (RGGB G): reads raw_data[3] = R₁ → routed to **channel 1 (G)** ✗
- column 4 (RGGB R): reads raw_data[4] = G₁ → routed to **channel 0 (R)** ✗
- column 5 (RGGB G): reads raw_data[5] = B₁ → routed to **channel 1 (G)** ✗

…and so on. Every other column routes blue samples into the red channel and
red/green samples into wrong channels. The bilinear demosaic then averages
these polluted positions. That is the source of the magenta cast (red and blue
samples landing in the red CFA position, blue samples landing in the green CFA
position). Then DCP applies AsShotNeutral on top of data that was already
white-balanced by the converter, doubling the warm-WB correction and pushing
the blue channel sky-high — that is the +0.694 bias_B observed in test_0006.

Furthermore, only every third row of the source is read at all (because rows
1, 2, 4, 5, … are at byte offsets the loop never visits), so the resulting
image is also missing two-thirds of its scanlines. The 5760-px wide candidate
is a horizontal slice of every third row of the source, mis-CFA-routed.

For test_0013 the same mechanism applies, but with two extra wrinkles: (a) a
12-bit `LinearizationTable` lookup that rawler does apply during decode, and
(b) an `Orientation: Rotate 90 CW` tag that the harness's resize-only flow
ignores. The orientation contributes to the 90° rotation visible in the
side-by-side, but as shown in §2 it is only a minor contributor to ΔE.

## 6. Root-cause hypothesis

**Real Maple bug, in the decode stage.** The `RawPhotometricInterpretation::
LinearRaw` branch in `src/raw-pipeline/raw-core/src/decode.rs:130-136` is
unimplemented. It falls back to a fake `RGGB` CFA pattern, which makes the
downstream `linearize` + `bilinear` demosaic + DCP chain misroute interleaved
RGB samples and double-apply white balance.

Confidence is high:

1. The bug is exactly in the path that the two catastrophic fixtures hit.
2. The `TODO` comment in `decode.rs` documents the bug.
3. Same-scene, same-camera, same-WB pair (test_0006 LinearRaw vs. test_0007
   CFA, both converted from `5G4A9394.CR2`) reproduces with mean ΔE 50.34 vs.
   9.47 — isolating the difference to the photometric path.
4. The visible cast (uniform magenta across both unrelated scenes — one Canon
   bathroom interior, one iPhone landscape) is a colorimetric fingerprint of
   the every-other-column sample misrouting, not a tone-mapping divergence.
5. The two fixtures are the **only** `LinearRaw` files in the suite; every
   other fixture is `Cfa` and renders within structural-mismatch budgets.

Not a camera-vendor divergence (the same Canon CR2 shot through the CFA path
is fine). Not a fixture-specific metadata oddity beyond
`PhotometricInterpretation` (everything else parses cleanly).

## 7. Recommendation

**Drop test_0006 and test_0013 from the parity gate** until
`decode::LinearRaw` is implemented. Two paths forward, in order of preference:

1. **Short term — drop the two LinearRaw fixtures from the harness.** They are
   not signal about Maple's color pipeline; they are noise from an
   unimplemented decode branch. Move them to a quarantine list (a comment in
   `test_color_pipeline.sh` noting which photometric interpretations are
   skipped, with this report linked) and re-include them after the bug is
   fixed. Do not recalibrate budgets — the budgets are correct; the inputs are
   wrong.

2. **Medium term — implement `LinearRaw` decode properly.** A proper
   implementation needs (a) `cpp != 1` plumbed through `RawImage` (currently
   raw_data is implicitly one sample per pixel), (b) `linearize` to handle
   3-SPP interleaved input by routing the three samples into the three
   channels of `Image::pixels` directly, skipping the demosaic step, (c) DCP
   to *not* apply `AsShotNeutral` again (because the file's WB is already
   baked in for LinearRaw — the converter applied it), and (d) the
   ProfileGainTableMap on test_0013 and the LinearizationTable on test_0013 to
   be honored or explicitly rejected. This is non-trivial. Track as a Plan
   item, not as a follow-up to this report.

3. (Not recommended — recalibrating budgets is wrong here.) Raising
   `BUDGET_BIAS` to 0.7 to absorb test_0006 would mask real future regressions
   in the CFA pipeline. The harness budgets are downward-only per `CLAUDE.md`.

4. (Not recommended — switching to Maple-frozen ground truth is a different
   investigation.) The harness's "embedded JPEG preview = ground truth" model
   is the wrong target for AgX parity in general — but that is a separate
   concern, not the cause of these two specific catastrophes. The other 4
   fixtures with mean ΔE 8–15 are the right venue for that conversation.

## Appendix — reproduction

```bash
# Render candidates
target/release/maple-cli render <fixture>.dng --out /tmp/maple-investigation/<stem>.candidate.png

# Extract reference embedded preview
PREVIEW_START=$(exiftool -s -s -s -n -PreviewImageStart <fixture>.dng)
PREVIEW_LEN=$(exiftool -s -s -s -n -PreviewImageLength <fixture>.dng)
dd if=<fixture>.dng of=/tmp/maple-investigation/<stem>.preview.jpg bs=1 \
   skip=$PREVIEW_START count=$PREVIEW_LEN status=none

# Diff (resize candidate to ref dims first using PIL Lanczos)
python3 src/scripts/compare_images.py <stem>.candidate.resized.png <stem>.preview.jpg

# Stage trace (raw → camera-native → BE → DCP)
cargo run --release -p raw-core --example dump_pixel -- <fixture>.dng <X> <Y> [<X2> <Y2> ...]
```

Working artifacts left under `/tmp/maple-investigation/` for the duration of
the investigation; both side-by-side `.sidebyside.png` and per-image
`.thumb.png` are visible there. The harness itself was not modified.
