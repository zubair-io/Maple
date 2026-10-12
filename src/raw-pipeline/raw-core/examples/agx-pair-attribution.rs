//! #3633 diagnostic: exposure needed to map display pairs through fixed AgX.
use raw_core::view::agx_inverse::display_u8_to_scene_linear;
use serde::{Deserialize, Serialize};
#[derive(Deserialize, Serialize)]
struct Pair {
    band: [u8; 2],
    x: u32,
    y: u32,
    candidate: [u8; 3],
    reference: [u8; 3],
}
fn luma(rgb: [u8; 3]) -> f32 {
    let s = display_u8_to_scene_linear(rgb, 1.0, 0.0);
    s[0] * 0.2627 + s[1] * 0.6780 + s[2] * 0.0593
}
fn shifted(rgb: [u8; 3], d: i16) -> [u8; 3] {
    rgb.map(|v| (v as i16 + d).clamp(0, 255) as u8)
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args().nth(1).expect("PAIRS_JSON");
    let pairs: Vec<Pair> = serde_json::from_str(&std::fs::read_to_string(path)?)?;
    let result: Vec<_> = pairs
        .iter()
        .map(|p| {
            serde_json::json!({"pair":p,
              "ev":(luma(p.reference)/luma(p.candidate)).log2(),
              "ev_low":(luma(shifted(p.reference,-1))/luma(shifted(p.candidate,1))).log2(),
              "ev_high":(luma(shifted(p.reference,1))/luma(shifted(p.candidate,-1))).log2()
            })
        })
        .collect();
    println!("{}", serde_json::to_string(&result)?);
    Ok(())
}
