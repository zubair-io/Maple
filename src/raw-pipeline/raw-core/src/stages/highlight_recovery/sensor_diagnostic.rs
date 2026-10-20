use super::{channels_at_or_above, channels_in_sensor_space};
use crate::{image::Image, sensor_gain_maps::ClipGainContext};
use std::io::Write;

pub(super) fn record(img: &Image, thresholds: [f32; 3], gains: ClipGainContext<'_>) {
    let Some(dir) = crate::stage_dump::dump_dir() else {
        return;
    };
    let mut unaware_pixels = 0usize;
    let mut aware_pixels = 0usize;
    let mut false_channels = 0usize;
    let mut missed_channels = 0usize;
    for (index, pixel) in img.pixels.iter().enumerate() {
        let before = channels_at_or_above(pixel, thresholds);
        let after = channels_in_sensor_space(pixel, thresholds, Some(gains), index, img.width);
        unaware_pixels += usize::from(before != 0);
        aware_pixels += usize::from(after != 0);
        false_channels += (before & !after).count_ones() as usize;
        missed_channels += (after & !before).count_ones() as usize;
    }
    let report = serde_json::json!({"width":img.width,"height":img.height,"uniform_thresholds":thresholds,"unaware_hard_clip_pixels":unaware_pixels,"aware_hard_clip_pixels":aware_pixels,"false_hard_clip_channels":false_channels,"missed_hard_clip_channels":missed_channels});
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("sensor_clip_counts.jsonl"))
    {
        if serde_json::to_writer(&mut file, &report).is_ok() {
            let _ = writeln!(file);
        }
    }
}
