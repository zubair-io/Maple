//! `maple-cli preview-coverage` — the Auto Profile embedded-preview audit
//! (#5458). For every RAW under the given files/directories it reports which
//! preview source wins with and without exiftool, every source's yield, the
//! RAW's size and the preview colour space, then a per-camera summary.
//! Markdown by default (the committed `docs/auto-preview-coverage.md` table);
//! `--json` prints one JSON object per RAW for further analysis.

use raw_core::view::auto_profile::preview_coverage::{
    is_supported_raw, preview_coverage, PreviewCoverage, SourceYield,
};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// A winner is flagged when another source's long edge is at least this many
/// times larger.
const MATERIAL_ALTERNATIVE_GAIN: f64 = 1.5;
/// A winner is flagged when its long edge is below this fraction of the
/// RAW's long edge.
const MIN_SENSOR_FRACTION: f64 = 0.25;

#[derive(clap::Args)]
pub struct Args {
    /// RAW files and/or directories (walked recursively without following
    /// directory symlinks; only extensions rawler decodes are read).
    #[arg(required = true)]
    paths: Vec<PathBuf>,
    /// Print one JSON object per RAW instead of the markdown tables.
    #[arg(long)]
    json: bool,
}

struct Row {
    file: String,
    coverage: PreviewCoverage,
    flags: Vec<String>,
}

#[derive(Default)]
struct Tally {
    raws: usize,
    no_preview_server: usize,
    no_preview_sandbox: usize,
    suspect: usize,
}

impl Tally {
    fn add(self, row: &Row) -> Self {
        Self {
            raws: self.raws + 1,
            no_preview_server: self.no_preview_server
                + usize::from(row.coverage.winner(true).is_none()),
            no_preview_sandbox: self.no_preview_sandbox
                + usize::from(row.coverage.winner(false).is_none()),
            suspect: self.suspect + usize::from(!row.flags.is_empty()),
        }
    }

    fn line(&self, camera: &str) -> String {
        format!(
            "| {camera} | {} | {} | {} | {} |",
            self.raws, self.no_preview_server, self.no_preview_sandbox, self.suspect
        )
    }
}

pub fn run(args: &Args) -> Result<i32, Box<dyn std::error::Error>> {
    let files = collect_raws(&args.paths)?;
    let rows: Vec<Row> = files
        .iter()
        .filter_map(|path| match preview_coverage(path) {
            Ok(coverage) => Some(Row {
                file: path.display().to_string(),
                flags: flags(&coverage),
                coverage,
            }),
            Err(e) => {
                eprintln!("skipped {e}");
                None
            }
        })
        .collect();
    if args.json {
        rows.iter().for_each(|row| {
            println!(
                "{}",
                serde_json::json!({
                    "file": row.file,
                    "coverage": row.coverage,
                    "winner_server": row.coverage.winner(true).map(|w| w.source),
                    "winner_sandbox": row.coverage.winner(false).map(|w| w.source),
                    "flags": row.flags,
                })
            )
        });
    } else {
        print_markdown(&rows);
    }
    Ok(0)
}

fn collect_raws(paths: &[PathBuf]) -> std::io::Result<Vec<PathBuf>> {
    let nested = paths
        .iter()
        .map(|path| walk(path))
        .collect::<std::io::Result<Vec<_>>>()?;
    let mut found: Vec<PathBuf> = nested.into_iter().flatten().collect();
    found.sort();
    Ok(found)
}

fn walk(path: &Path) -> std::io::Result<Vec<PathBuf>> {
    let is_real_dir = std::fs::symlink_metadata(path)?.is_dir();
    if !is_real_dir {
        return Ok(if is_supported_raw(path) {
            vec![path.to_path_buf()]
        } else {
            Vec::new()
        });
    }
    std::fs::read_dir(path)?
        .map(|entry| walk(&entry?.path()))
        .collect::<std::io::Result<Vec<_>>>()
        .map(|nested| nested.into_iter().flatten().collect())
}

fn camera(c: &PreviewCoverage) -> String {
    let make = c.make.trim();
    let model = c.model.trim();
    let name = if make.is_empty() || model.starts_with(make) {
        model.to_string()
    } else {
        format!("{make} {model}")
    };
    if name.is_empty() {
        "(no camera metadata)".into()
    } else {
        name
    }
}

fn long_edge(size: [u32; 2]) -> f64 {
    f64::from(size[0].max(size[1]))
}

fn describe(winner: Option<&SourceYield>, sensor: Option<[u32; 2]>) -> String {
    match (winner, winner.and_then(|w| w.size)) {
        (Some(w), Some(size)) => {
            let ratio = sensor.map_or(String::new(), |s| {
                format!(" ({:.2})", long_edge(size) / long_edge(s))
            });
            format!("{} {}×{}{ratio}", w.source.label(), size[0], size[1])
        }
        _ => "none".into(),
    }
}

/// Why the server winner is suspect, empty when it is not.
fn flags(c: &PreviewCoverage) -> Vec<String> {
    let Some(size) = c.winner(true).and_then(|w| w.size) else {
        return Vec::new();
    };
    let larger = c
        .sources
        .iter()
        .filter_map(|s| s.size.map(|alt| (s.source, alt)))
        .filter(|(_, alt)| long_edge(*alt) >= long_edge(size) * MATERIAL_ALTERNATIVE_GAIN)
        .map(|(source, alt)| format!("{} is {}×{}", source.label(), alt[0], alt[1]));
    let tiny = c
        .sensor
        .filter(|s| long_edge(size) < long_edge(*s) * MIN_SENSOR_FRACTION)
        .map(|_| "below sensor floor".to_string());
    larger.chain(tiny).collect()
}

fn print_markdown(rows: &[Row]) {
    println!("| File | Camera | Format | Sensor | Colour space | Winner (server) | Winner (sandbox/WASM) | Other sources | Flags |");
    println!("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    rows.iter().for_each(|row| {
        let c = &row.coverage;
        let server = c.winner(true);
        let others: Vec<String> = c
            .sources
            .iter()
            .filter(|s| s.size.is_some() && Some(s.source) != server.map(|w| w.source))
            .map(|s| describe(Some(s), c.sensor))
            .collect();
        let name = Path::new(&row.file)
            .file_name()
            .map_or(row.file.clone(), |n| n.to_string_lossy().into_owned());
        println!(
            "| {name} | {} | {} | {} | {} | {} | {} | {} | {} |",
            camera(c),
            c.format,
            c.sensor
                .map_or("?".into(), |s| format!("{}×{}", s[0], s[1])),
            c.color_space,
            describe(server, c.sensor),
            describe(c.winner(false), c.sensor),
            if others.is_empty() {
                "—".into()
            } else {
                others.join("; ")
            },
            row.flags.join("; "),
        );
    });
    let cameras = rows
        .iter()
        .fold(BTreeMap::<String, Tally>::new(), |mut cameras, row| {
            let key = camera(&row.coverage);
            let tally = cameras.remove(&key).unwrap_or_default().add(row);
            cameras.insert(key, tally);
            cameras
        });
    let all = rows.iter().fold(Tally::default(), Tally::add);
    println!();
    println!(
        "| Camera | RAWs | No preview (server) | No preview (sandbox/WASM) | Suspect winner |"
    );
    println!("| --- | --- | --- | --- | --- |");
    cameras
        .iter()
        .for_each(|(camera, tally)| println!("{}", tally.line(camera)));
    println!("{}", all.line("**All**"));
}

#[cfg(test)]
mod tests {
    use super::*;
    use raw_core::view::auto_profile::PreviewSource;

    fn coverage(sensor: [u32; 2], sizes: &[Option<[u32; 2]>]) -> PreviewCoverage {
        PreviewCoverage {
            make: "Maple".into(),
            model: "Maple Test".into(),
            format: "DNG".into(),
            sensor: Some(sensor),
            color_space: "sRGB",
            sources: PreviewSource::IN_PROCESS
                .into_iter()
                .zip(sizes)
                .map(|(source, &size)| SourceYield { source, size })
                .collect(),
        }
    }

    #[test]
    fn flags_follow_the_alternative_gain_and_sensor_floor() {
        let sensor = [4000, 3000];
        assert!(flags(&coverage(sensor, &[None, Some([1000, 750])])).is_empty());
        assert_eq!(
            flags(&coverage(sensor, &[None, Some([999, 750])])),
            ["below sensor floor"]
        );
        assert!(flags(&coverage(sensor, &[Some([1000, 750]), Some([1499, 1000])])).is_empty());
        assert_eq!(
            flags(&coverage(sensor, &[Some([1000, 750]), Some([1500, 1000])])),
            ["full_image is 1500×1000"]
        );
        assert!(flags(&coverage(sensor, &[None, None, None])).is_empty());
    }

    #[test]
    fn camera_drops_a_make_the_model_repeats() {
        assert_eq!(camera(&coverage([1, 1], &[])), "Maple Test");
    }
}
