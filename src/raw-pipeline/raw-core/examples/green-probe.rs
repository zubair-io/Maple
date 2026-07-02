// #871 diagnostic: what does raw-core's display encode produce for a
// saturated display-linear Rec.2020 green (and other gamut probes)?
use raw_core::color::matrices::M_REC2020_TO_SRGB;
use raw_core::image::{ColorSpace, Image};
use raw_core::view::encode::{rec2020_to_srgb, srgb_gamma};

fn probe(name: &str, rgb: [f32; 3]) {
    // raw-core display path: rec2020->srgb (Oklab gamut compression) then gamma.
    let mut img = Image::new(1, 1, ColorSpace::DisplayLinearRec2020);
    img.pixels[0] = rgb;
    rec2020_to_srgb(&mut img);
    let lin = img.pixels[0];
    let enc = [srgb_gamma(lin[0]), srgb_gamma(lin[1]), srgb_gamma(lin[2])];
    let u8v = |x: f32| (x * 255.0 + 0.5).clamp(0.0, 255.0) as i32;
    // Naive per-channel clip (what a non-extended sRGB CoreImage conversion does):
    let m = M_REC2020_TO_SRGB.mul_vec(rgb);
    let clip = [
        m[0].clamp(0.0, 1.0),
        m[1].clamp(0.0, 1.0),
        m[2].clamp(0.0, 1.0),
    ];
    let clip_enc = [
        srgb_gamma(clip[0]),
        srgb_gamma(clip[1]),
        srgb_gamma(clip[2]),
    ];
    let luma = |c: [f32; 3]| 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    println!("=== {name}  in(rec2020-disp-lin)={:?}", rgb);
    println!(
        "  post-matrix sRGB-lin (raw)= [{:.4} {:.4} {:.4}]",
        m[0], m[1], m[2]
    );
    println!(
        "  raw-core Oklab-compressed sRGB-lin= [{:.4} {:.4} {:.4}]",
        lin[0], lin[1], lin[2]
    );
    println!(
        "  raw-core encoded u8= [{} {} {}]  luma_enc={:.4}",
        u8v(enc[0]),
        u8v(enc[1]),
        u8v(enc[2]),
        luma(enc)
    );
    println!(
        "  per-chan-clip encoded u8= [{} {} {}]  luma_enc={:.4}",
        u8v(clip_enc[0]),
        u8v(clip_enc[1]),
        u8v(clip_enc[2]),
        luma(clip_enc)
    );
}

fn main() {
    // AgX-output display-linear values are in [0,1]. Saturated green near the
    // Rec.2020 green primary, at a few brightness levels.
    probe("sat-green-0.5", [0.0, 0.5, 0.0]);
    probe("sat-green-0.8", [0.0, 0.8, 0.0]);
    probe("sat-green-1.0", [0.0, 1.0, 0.0]);
    probe("bright-yellowgreen", [0.4, 0.9, 0.1]);
    probe("near-white-highlight", [0.95, 0.97, 0.9]);
    probe("neutral-mid", [0.46, 0.46, 0.46]);
}
