//! The per-mask SPATIAL group's end-to-end regression gate (#3407).
//!
//! # What this pins, and what it deliberately does not
//!
//! `spatial.rs`'s own unit tests prove the ALGEBRA — that the delta form
//! reduces to the global stage at full mask weight and to identity at zero.
//! `raw-gpu`'s `local_spatial/tests.rs` proves CPU/GPU agreement. Neither
//! notices if a kernel this stage calls quietly changes what it produces,
//! because both sides would move together.
//!
//! This test is the third leg: a committed reference image. It parses the
//! real sidecar at `test-fixtures/local-adjustments/spatial-radial.xmp` —
//! Lightroom-shaped, one radial correction carrying all six keys — applies
//! the stage to a deterministic synthetic scene, and diffs the result
//! against a 16-bit PNG committed beside it.
//!
//! What it is NOT is a COLOUR gate. #1478 (the local-adjustment reference
//! fixture) is still open, so no reference renderer has ever rendered a
//! local adjustment for Maple to be measured against; there is no ACR
//! reference PNG for this or any other local-adjustment case, and none of
//! the numbers here say anything about whether the six controls match
//! Lightroom's. They say the maths did not change by accident. When #1478
//! lands its ACR reference, this case belongs in
//! `test-fixtures/references/manifest.json` alongside it.
//!
//! # Tolerance
//!
//! Per channel, 128 counts of 65535 (~2e-3). Tight enough that any real
//! change to the guided filter, the unsharp mask, the NLM kernel, the
//! dehaze recovery or the chroma suppression moves pixels far past it;
//! loose enough to absorb `cbrt` / `powf` differing in the last places
//! between platform math libraries, which the Oklab round trips inside
//! defringe and NLM make unavoidable.
//!
//! # Re-recording
//!
//! Delete the PNG and re-run: the test writes a fresh baseline and fails
//! with "baseline written". Open it, confirm the change was intended, then
//! commit the new file alongside whatever produced it.

use std::path::PathBuf;

use crate::image::{ColorSpace, Image};
use crate::types::LocalAdjustment;
use crate::xmp;

/// Long edge of the synthetic scene. Small enough that the PNG is a few KB,
/// large enough that clarity's radius-20 guided filter has an interior.
const W: u32 = 64;
const H: u32 = 48;

/// Per-channel tolerance, in 16-bit counts. See the module header.
const TOLERANCE: i32 = 128;

fn fixture_dir() -> PathBuf {
    // `CARGO_MANIFEST_DIR` is `src/raw-pipeline/raw-core`; the fixtures live
    // at the repo root, four levels up.
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../test-fixtures/local-adjustments")
}

/// A deterministic scene with structure at both the clarity scale (~20 px)
/// and the texture / sharpen scale (1–2 px), a saturated magenta column for
/// defringe to bite on, and a dark band so the tone-coupled halves of the
/// group are not evaluated only on midtones.
fn synthetic_scene() -> Image {
    let mut img = Image::new(W, H, ColorSpace::SceneLinearRec2020);
    for y in 0..H as usize {
        for x in 0..W as usize {
            let coarse: f32 = if ((x / 16) + (y / 16)) % 2 == 0 {
                0.62
            } else {
                0.09
            };
            let fine: f32 = if (x * 3 + y) % 5 == 0 { 0.05 } else { -0.02 };
            let base = f32::max(coarse + fine, 0.004);
            img.pixels[y * W as usize + x] = if x == 24 {
                [base * 1.45, base * 0.22, base * 1.4]
            } else {
                [base, base * 0.94, base * 1.08]
            };
        }
    }
    img
}

fn layers() -> Vec<LocalAdjustment> {
    let path = fixture_dir().join("spatial-radial.xmp");
    let doc =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    let model = xmp::parse(&doc).expect("parse the spatial-radial sidecar");
    assert_eq!(
        model.local_adjustments.len(),
        1,
        "the fixture carries exactly one correction"
    );
    let a = &model.local_adjustments[0].adjustments;
    for (name, value) in [
        ("texture", a.texture),
        ("clarity", a.clarity),
        ("dehaze", a.dehaze),
        ("sharpness", a.sharpness),
        ("luminance_noise", a.luminance_noise),
        ("defringe", a.defringe),
    ] {
        assert!(
            value.is_some_and(|v| v.abs() >= 1e-3),
            "the fixture must engage {name}, or the golden is vacuous for it"
        );
    }
    model.local_adjustments
}

/// Scene-linear f32 → 16-bit RGB, clamped to the unit range. The scene never
/// exceeds 1.0 by much, and the clamp is a property of the GOLDEN's encoding
/// rather than of the stage, which stays unbounded.
fn to_u16(img: &Image) -> Vec<u16> {
    img.pixels
        .iter()
        .flat_map(|p| {
            p.iter()
                .map(|v| (v.clamp(0.0, 1.0) * 65535.0).round() as u16)
                .collect::<Vec<_>>()
        })
        .collect()
}

fn write_png(path: &std::path::Path, data: &[u16]) {
    let file = std::fs::File::create(path).expect("create golden");
    let mut encoder = png::Encoder::new(std::io::BufWriter::new(file), W, H);
    encoder.set_color(png::ColorType::Rgb);
    encoder.set_depth(png::BitDepth::Sixteen);
    let bytes: Vec<u8> = data.iter().flat_map(|v| v.to_be_bytes()).collect();
    encoder
        .write_header()
        .expect("png header")
        .write_image_data(&bytes)
        .expect("png data");
}

fn read_png(path: &std::path::Path) -> Vec<u16> {
    let file = std::fs::File::open(path).expect("open golden");
    let decoder = png::Decoder::new(std::io::BufReader::new(file));
    let mut reader = decoder.read_info().expect("png info");
    let mut buf = vec![0u8; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).expect("png frame");
    assert_eq!(info.width, W);
    assert_eq!(info.height, H);
    assert_eq!(info.bit_depth, png::BitDepth::Sixteen);
    assert_eq!(info.color_type, png::ColorType::Rgb);
    buf[..info.buffer_size()]
        .chunks_exact(2)
        .map(|c| u16::from_be_bytes([c[0], c[1]]))
        .collect()
}

#[test]
fn the_spatial_group_reproduces_its_committed_golden() {
    let layers = layers();
    let mut img = synthetic_scene();
    super::apply(&mut img, &layers, &[]);
    let rendered = to_u16(&img);

    let golden_path = fixture_dir().join("spatial-radial.png");
    if !golden_path.exists() {
        write_png(&golden_path, &rendered);
        panic!(
            "baseline written to {} — inspect it, then commit it and re-run",
            golden_path.display()
        );
    }

    let golden = read_png(&golden_path);
    assert_eq!(
        golden.len(),
        rendered.len(),
        "golden has {} samples, render has {}",
        golden.len(),
        rendered.len()
    );
    let worst =
        golden
            .iter()
            .zip(&rendered)
            .enumerate()
            .fold((0usize, 0i32), |acc, (i, (g, r))| {
                let d = (*g as i32 - *r as i32).abs();
                if d > acc.1 {
                    (i, d)
                } else {
                    acc
                }
            });
    eprintln!(
        "GOLDEN local spatial [spatial-radial]: worst channel delta {} counts \
         at sample {} (tolerance {TOLERANCE})",
        worst.1, worst.0
    );
    assert!(
        worst.1 <= TOLERANCE,
        "sample {} differs from the committed golden by {} counts (> {TOLERANCE}). \
         If the change was intended, delete {} and re-run to re-record.",
        worst.0,
        worst.1,
        golden_path.display()
    );
}

/// The same scene with an EMPTY layer stack must come back bit-identical —
/// the guard that keeps every existing colour-harness fixture on its
/// baseline, since the spatial group only ever runs for a layer that asked
/// for it.
#[test]
fn an_empty_layer_stack_leaves_the_scene_bit_identical() {
    let before = synthetic_scene();
    let mut after = before.clone();
    super::apply(&mut after, &[], &[]);
    assert_eq!(after.pixels, before.pixels);
}

/// The golden is only worth committing if the correction actually did
/// something, and only inside its mask. Pins both ends: the frame's corners
/// sit at mask weight 0 and must be BIT-identical to the input scene, while
/// the mask's centre must have moved by a visible margin.
#[test]
fn the_fixture_correction_is_confined_to_its_mask_and_is_not_vacuous() {
    let before = synthetic_scene();
    let mut after = before.clone();
    super::apply(&mut after, &layers(), &[]);

    let at = |x: usize, y: usize| y * W as usize + x;
    for (x, y) in [(0, 0), (W as usize - 1, 0), (0, H as usize - 1)] {
        assert_eq!(
            after.pixels[at(x, y)],
            before.pixels[at(x, y)],
            "({x}, {y}) sits outside the radial mask and must be untouched"
        );
    }
    let centre = at(W as usize / 2, H as usize / 2);
    let delta = (0..3)
        .map(|c| (after.pixels[centre][c] - before.pixels[centre][c]).abs())
        .fold(0.0_f32, f32::max);
    assert!(
        delta > 0.05,
        "the mask centre moved by only {delta}; the golden would be vacuous"
    );
}
