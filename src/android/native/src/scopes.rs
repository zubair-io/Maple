//! Bounded idle readback; all scope colour reduction stays in the shared core.
use raw_core::scope::{
    cb_cr_rec709,
    density::{reduce_density, DENSITY_BINS, DENSITY_PLANE},
    panel::{reduce_panel, PANEL_COLUMNS, PANEL_VALUES},
};

pub const VECTORSCOPE_GRID: usize = 32;

pub fn sample(pixels: &[u32], width: u32, height: u32) -> Result<String, String> {
    if width > raw_core::scope::SCOPE_SNAPSHOT_MAX_DIM
        || height > raw_core::scope::SCOPE_SNAPSHOT_MAX_DIM
        || pixels.len() != width as usize * height as usize
    {
        return Err("Invalid scope snapshot dimensions".into());
    }
    let rgb: Vec<u8> = pixels
        .iter()
        .flat_map(|pixel| [(pixel >> 16) as u8, (pixel >> 8) as u8, *pixel as u8])
        .collect();
    let mut panel = [0.0; PANEL_VALUES];
    reduce_panel(&rgb, width, height, &mut panel)?;
    let density = reduce_density(&rgb, width, height)?;
    let mut vs_counts = vec![0.0_f64; VECTORSCOPE_GRID * VECTORSCOPE_GRID];
    for pixel in rgb.chunks_exact(3) {
        let (cb, cr) = cb_cr_rec709([
            pixel[0] as f32 / 255.0,
            pixel[1] as f32 / 255.0,
            pixel[2] as f32 / 255.0,
        ]);
        let col =
            (((cb + 0.5) * VECTORSCOPE_GRID as f32).max(0.0) as usize).min(VECTORSCOPE_GRID - 1);
        let row =
            (((cr + 0.5) * VECTORSCOPE_GRID as f32).max(0.0) as usize).min(VECTORSCOPE_GRID - 1);
        vs_counts[row * VECTORSCOPE_GRID + col] += 1.0;
    }
    let normalize = |counts: &[f64]| {
        let peak = counts.iter().copied().fold(0.0_f64, f64::max).ln_1p();
        counts
            .iter()
            .map(|count| {
                if peak > 0.0 {
                    count.ln_1p() / peak
                } else {
                    0.0
                }
            })
            .collect::<Vec<_>>()
    };
    let channels: Vec<_> = panel[..3 * PANEL_COLUMNS]
        .chunks_exact(PANEL_COLUMNS)
        .map(normalize)
        .collect();
    let planes: Vec<_> = density
        .chunks_exact(DENSITY_PLANE)
        .map(|plane| normalize(&plane.iter().map(|n| *n as f64).collect::<Vec<_>>()))
        .collect();
    let vectorscope = normalize(&vs_counts);
    Ok(serde_json::json!({
        "columns": PANEL_COLUMNS,
        "bins": DENSITY_BINS,
        "vectorscopeBins": VECTORSCOPE_GRID,
        "channels": channels,
        "waveformLuma": planes[0],
        "paradeR": planes[1],
        "paradeG": planes[2],
        "paradeB": planes[3],
        "vectorscope": vectorscope,
    })
    .to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sample_produces_vectorscope_from_shared_core_rec709_chroma() {
        // Pure neutral grey (128, 128, 128) lands in the center of the vectorscope grid.
        let grey = 0xFF808080_u32;
        let json: serde_json::Value =
            serde_json::from_str(&sample(&[grey; 4], 2, 2).unwrap()).unwrap();
        assert_eq!(json["vectorscopeBins"], VECTORSCOPE_GRID);
        let vs = json["vectorscope"].as_array().unwrap();
        assert_eq!(vs.len(), VECTORSCOPE_GRID * VECTORSCOPE_GRID);
        let center = (VECTORSCOPE_GRID / 2) * VECTORSCOPE_GRID + (VECTORSCOPE_GRID / 2);
        assert!(vs[center].as_f64().unwrap() > 0.99);
    }
}
