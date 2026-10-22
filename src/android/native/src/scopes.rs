//! Bounded idle readback; all scope colour reduction stays in the shared core.
use raw_core::scope::{
    density::{reduce_density, DENSITY_BINS, DENSITY_PLANE},
    panel::{reduce_panel, PANEL_COLUMNS, PANEL_VALUES},
};

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
    Ok(serde_json::json!({"columns": PANEL_COLUMNS, "bins": DENSITY_BINS, "channels": channels,
        "waveformLuma": planes[0], "paradeR": planes[1], "paradeG": planes[2], "paradeB": planes[3]}).to_string())
}
