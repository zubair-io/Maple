//! `maple-cli preview-coverage` — the Auto Profile embedded-preview audit
//! (#5458). For every RAW under the given files/directories it reports which
//! preview source wins with and without exiftool, every source's yield, the
//! sensor size and the preview colour space, then a per-camera summary.
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
/// sensor's long edge.
const MIN_SENSOR_FRACTION: f64 = 0.25;

#[derive(clap::Args)]
pub struct Args {
    /// RAW files and/or directories (walked recursively; only extensions
    /// rawler decodes are read).
    #[arg(required = true)]
    paths: Vec<PathBuf>,
    /// Print one JSON object per RAW instead of the markdown tables.
    #[arg(long)]
    json: bool,
}

fn camera(c: &PreviewCoverage) -> String {
    let name = format!("{} {}", c.make, c.model);
    if name.trim().is_empty() {
        "(no camera metadata)".into()
    } else {
        name.trim().to_string()
    }
}

struct Row {
    file: String,
    coverage: PreviewCoverage,
}

pub fn run(args: &Args) -> Result<i32, Box<dyn std::error::Error>> {
    let files = collect_raws(&args.paths)?;
    let rows: Vec<Row> = files
        .iter()
        .filter_map(|path| match preview_coverage(path) {
            Ok(coverage) => Some(Row {
                file: path.display().to_string(),
                coverage,
            }),
            Err(e) => {
                eprintln!("skipped {e}");
                None
            }
        })
        .collect();
    if args.json {
        for row in &rows {
            println!(
                "{}",
                serde_json::json!({ "file": row.file, "coverage": row.coverage })
            );
        }
    } else {
        print_markdown(&rows);
    }
    Ok(0)
}

fn collect_raws(paths: &[PathBuf]) -> std::io::Result<Vec<PathBuf>> {
    let mut found = Vec::new();
    for path in paths {
        walk(path, &mut found)?;
    }
    found.sort();
    Ok(found)
}

fn walk(path: &Path, found: &mut Vec<PathBuf>) -> std::io::Result<()> {
    if path.is_dir() {
        for entry in std::fs::read_dir(path)? {
            walk(&entry?.path(), found)?;
        }
    } else if is_supported_raw(path) {
        found.push(path.to_path_buf());
    }
    Ok(())
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
    for row in rows {
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
            flags(c).join("; "),
        );
    }
    let mut cameras: BTreeMap<String, [usize; 4]> = BTreeMap::new();
    for row in rows {
        let c = &row.coverage;
        let tally = cameras.entry(camera(c)).or_default();
        tally[0] += 1;
        tally[1] += usize::from(c.winner(true).is_none());
        tally[2] += usize::from(c.winner(false).is_none());
        tally[3] += usize::from(!flags(c).is_empty());
    }
    println!();
    println!(
        "| Camera | RAWs | No preview (server) | No preview (sandbox/WASM) | Suspect winner |"
    );
    println!("| --- | --- | --- | --- | --- |");
    for (camera, [n, none, sandbox_none, suspect]) in &cameras {
        println!("| {camera} | {n} | {none} | {sandbox_none} | {suspect} |");
    }
    let total = |i: usize| cameras.values().map(|t| t[i]).sum::<usize>();
    println!(
        "| **All** | {} | {} | {} | {} |",
        total(0),
        total(1),
        total(2),
        total(3)
    );
}
