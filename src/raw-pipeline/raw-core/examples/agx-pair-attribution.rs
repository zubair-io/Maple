//! Reproduce #3633's fixed-AgX exposure attribution from an equal-size PNG pair.
use raw_core::view::agx_inverse::display_u8_to_scene_linear;
use serde_json::{json, Value};

const BANDS: [(u8, u8); 3] = [(10, 30), (30, 60), (60, 90)];
const SAMPLE_LIMIT: usize = 1_000;

#[derive(Clone)]
struct PixelPair {
    score: u64,
    x: u32,
    y: u32,
    candidate: [u8; 3],
    reference: [u8; 3],
}

fn rgb(pixels: &[u8], width: usize, x: usize, y: usize) -> [u8; 3] {
    let offset = (y * width + x) * 3;
    [pixels[offset], pixels[offset + 1], pixels[offset + 2]]
}

fn channel_spread(rgb: [u8; 3]) -> u8 {
    rgb.into_iter().max().unwrap() - rgb.into_iter().min().unwrap()
}

fn reference_band(rgb: [u8; 3]) -> Option<usize> {
    let mean_code = rgb.into_iter().map(u16::from).sum::<u16>() / 3;
    BANDS
        .iter()
        .position(|&(low, high)| u16::from(low) <= mean_code && mean_code < u16::from(high))
}

fn in_code_range(rgb: [u8; 3]) -> bool {
    rgb.into_iter().all(|code| (10..=245).contains(&code))
}

fn neighbors_are_flat(pixels: &[u8], width: usize, x: usize, y: usize) -> bool {
    let center = rgb(pixels, width, x, y);
    [(x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)]
        .into_iter()
        .all(|(neighbor_x, neighbor_y)| {
            let neighbor = rgb(pixels, width, neighbor_x, neighbor_y);
            center
                .into_iter()
                .zip(neighbor)
                .all(|(code, neighbor_code)| code.abs_diff(neighbor_code) <= 3)
        })
}

fn stable_score(x: u32, y: u32, band: usize) -> u64 {
    let coordinate = (u64::from(y) << 32) | u64::from(x);
    let mut value = coordinate ^ ((band as u64) << 56) ^ 0x3633_2026_1005_0001;
    value = value.wrapping_add(0x9e37_79b9_7f4a_7c15);
    value = (value ^ (value >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    value = (value ^ (value >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    value ^ (value >> 31)
}

fn luma(rgb: [u8; 3]) -> f32 {
    let scene = display_u8_to_scene_linear(rgb, 1.0, 0.0);
    scene[0] * 0.2627 + scene[1] * 0.6780 + scene[2] * 0.0593
}

fn shifted(rgb: [u8; 3], delta: i16) -> [u8; 3] {
    rgb.map(|code| (i16::from(code) + delta).clamp(0, 255) as u8)
}

fn ev_bounds(pair: &PixelPair) -> (f32, f32, f32) {
    let candidate_luma = luma(pair.candidate);
    let reference_luma = luma(pair.reference);
    let ev = (reference_luma / candidate_luma).log2();
    let ev_low = (luma(shifted(pair.reference, -1)) / luma(shifted(pair.candidate, 1))).log2();
    let ev_high = (luma(shifted(pair.reference, 1)) / luma(shifted(pair.candidate, -1))).log2();
    (ev, ev_low, ev_high)
}

fn median(mut values: Vec<f32>) -> Option<f32> {
    if values.is_empty() {
        return None;
    }
    values.sort_by(f32::total_cmp);
    let middle = values.len() / 2;
    let result = if values.len() % 2 == 0 {
        (values[middle - 1] + values[middle]) / 2.0
    } else {
        values[middle]
    };
    Some((result * 10_000.0).round() / 10_000.0)
}

fn summarize_band(band: usize, mut pairs: Vec<PixelPair>) -> Value {
    let eligible_pixels = pairs.len();
    pairs.sort_unstable_by_key(|pair| (pair.score, pair.y, pair.x));
    pairs.truncate(SAMPLE_LIMIT);
    let estimates = pairs.iter().map(ev_bounds).collect::<Vec<_>>();
    let samples = pairs
        .iter()
        .zip(&estimates)
        .map(|(pair, &(required_ev, ev_low, ev_high))| {
            json!({
                "x": pair.x,
                "y": pair.y,
                "candidate_rgb": pair.candidate,
                "reference_rgb": pair.reference,
                "required_ev": required_ev,
                "ev_low": ev_low,
                "ev_high": ev_high,
            })
        })
        .collect::<Vec<_>>();
    json!({
        "reference_mean_code_band": BANDS[band],
        "eligible_pixels": eligible_pixels,
        "sampled_pixels": pairs.len(),
        "median_required_ev": median(estimates.iter().map(|estimate| estimate.0).collect()),
        "median_ev_low": median(estimates.iter().map(|estimate| estimate.1).collect()),
        "median_ev_high": median(estimates.iter().map(|estimate| estimate.2).collect()),
        "samples": samples,
    })
}

fn analyze(candidate: &image::RgbImage, reference: &image::RgbImage) -> Value {
    let width = candidate.width() as usize;
    let height = candidate.height() as usize;
    let candidate_pixels = candidate.as_raw();
    let reference_pixels = reference.as_raw();
    let mut by_band: [Vec<PixelPair>; 3] = std::array::from_fn(|_| Vec::new());

    for y in 1..height.saturating_sub(1) {
        for x in 1..width.saturating_sub(1) {
            let candidate_rgb = rgb(candidate_pixels, width, x, y);
            let reference_rgb = rgb(reference_pixels, width, x, y);
            let Some(band) = reference_band(reference_rgb) else {
                continue;
            };
            if channel_spread(candidate_rgb) > 5
                || channel_spread(reference_rgb) > 3
                || !in_code_range(candidate_rgb)
                || !in_code_range(reference_rgb)
                || !neighbors_are_flat(candidate_pixels, width, x, y)
                || !neighbors_are_flat(reference_pixels, width, x, y)
            {
                continue;
            }
            let (x, y) = (x as u32, y as u32);
            by_band[band].push(PixelPair {
                score: stable_score(x, y, band),
                x,
                y,
                candidate: candidate_rgb,
                reference: reference_rgb,
            });
        }
    }

    json!({
        "schema_version": 1,
        "dimensions": [candidate.width(), candidate.height()],
        "sampling": {
            "maximum_per_band": SAMPLE_LIMIT,
            "method": "lowest fixed SplitMix64 score of (x, y, band), ties by y then x",
        },
        "filters": {
            "candidate_channel_spread_max": 5,
            "reference_channel_spread_max": 3,
            "channel_code_range_inclusive": [10, 245],
            "cardinal_neighbor_channel_delta_max": 3,
            "reference_band_code": "floor((R + G + B) / 3)",
        },
        "bands": by_band.into_iter().enumerate()
            .map(|(band, pairs)| summarize_band(band, pairs))
            .collect::<Vec<_>>(),
    })
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let candidate_path = args.next().expect("CANDIDATE_PNG");
    let reference_path = args.next().expect("REFERENCE_PNG");
    assert!(
        args.next().is_none(),
        "expected CANDIDATE_PNG REFERENCE_PNG"
    );

    let candidate = image::open(candidate_path)?.to_rgb8();
    let reference = image::open(reference_path)?.to_rgb8();
    if candidate.dimensions() != reference.dimensions() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "candidate and reference PNG dimensions must match",
        )
        .into());
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&analyze(&candidate, &reference))?
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reference_bands_use_half_open_mean_code_ranges() {
        assert_eq!(reference_band([10, 10, 10]), Some(0));
        assert_eq!(reference_band([30, 30, 30]), Some(1));
        assert_eq!(reference_band([60, 60, 60]), Some(2));
        assert_eq!(reference_band([90, 90, 90]), None);
    }

    #[test]
    fn flatness_checks_each_channel_against_all_cardinal_neighbors() {
        let mut pixels = vec![100; 3 * 3 * 3];
        assert!(neighbors_are_flat(&pixels, 3, 1, 1));
        pixels[(1 * 3 + 2) * 3 + 1] = 104;
        assert!(!neighbors_are_flat(&pixels, 3, 1, 1));
    }

    #[test]
    fn sample_score_is_stable_and_changes_with_coordinates() {
        assert_eq!(stable_score(12, 34, 1), stable_score(12, 34, 1));
        assert_ne!(stable_score(12, 34, 1), stable_score(12, 35, 1));
    }

    #[test]
    fn analysis_filters_pairs_and_reports_the_sampled_pixels() {
        let candidate = image::RgbImage::from_pixel(5, 5, image::Rgb([20, 20, 20]));
        let reference = image::RgbImage::from_pixel(5, 5, image::Rgb([22, 22, 22]));

        let report = analyze(&candidate, &reference);
        assert_eq!(report["bands"][0]["eligible_pixels"], 9);
        assert_eq!(report["bands"][0]["sampled_pixels"], 9);
        assert_eq!(report["bands"][0]["samples"].as_array().unwrap().len(), 9);
        assert_eq!(report, analyze(&candidate, &reference));
    }
}
