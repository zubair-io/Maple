//! Bake the AcrMatch 3D LUT to a binary file.
//!
//! Usage:
//!   cargo run --release --example bake-acr-match-lut -p raw-core -- <output.bin>
//!
//! The output is N³ × 3 f32 values in little-endian byte order, where N = ACR_MATCH_LUT_N.
//! This file is committed as `src/view/acr_match_lut.bin` and embedded by the GPU path.

use raw_core::view::acr_match::{bake_acr_match_lut, ACR_MATCH_LUT_N};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let out_path = args
        .get(1)
        .map(String::as_str)
        .unwrap_or("acr_match_lut.bin");

    eprintln!(
        "Baking AcrMatch 3D LUT ({n}³ × 3 f32)…",
        n = ACR_MATCH_LUT_N
    );
    let data = bake_acr_match_lut(ACR_MATCH_LUT_N);

    let bytes: Vec<u8> = data.iter().flat_map(|f| f.to_le_bytes()).collect();

    std::fs::write(out_path, &bytes).expect("failed to write LUT binary");
    eprintln!(
        "Wrote {} bytes to {out_path} ({n}³×3×4 = {})",
        bytes.len(),
        ACR_MATCH_LUT_N * ACR_MATCH_LUT_N * ACR_MATCH_LUT_N * 3 * 4,
        n = ACR_MATCH_LUT_N,
    );
}
