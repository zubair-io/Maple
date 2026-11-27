//! Times a local grid thumbnail through `ThumbnailWorker` on N threads, and the embedded-preview alternative, to inform owner decisions 13 and 21; changes nothing in the app.
//!
//! Usage: thumbnail-cost write-dng <path> | thumbnail-cost [--workers N] [raw ...]
//! With no RAW it measures a generated 24 MP uncompressed RGGB DNG (four copies).
mod synthetic_dng;

use maple_linux::{
    jobs::ThumbnailWorker,
    library::{MediaKind, Photo},
};
use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard, PoisonError},
    time::{Duration, Instant, SystemTime},
};

const SYNTHETIC_COPIES: usize = 4;
const EMBEDDED_ROUNDS: usize = 5;
const SYNTHETIC_NOTE: &str = "generated, uncompressed, RGGB, no embedded preview: decompression and the Auto profile's fit are not exercised and the embedded-preview path cannot be timed";

struct Fixture {
    name: String,
    photo: Photo,
    megapixels: f64,
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn millis(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1000.0
}

fn median(mut values: Vec<f64>) -> f64 {
    values.sort_by(f64::total_cmp);
    values[values.len() / 2]
}

fn extension(path: &Path) -> &str {
    path.extension()
        .and_then(|value| value.to_str())
        .unwrap_or("dng")
}

fn stage(path: PathBuf, name: String) -> Result<Fixture, String> {
    let bytes = std::fs::read(&path).map_err(|error| format!("{name}: {error}"))?;
    let raw = raw_core::decode::decode_bytes(&bytes, extension(&path))
        .map_err(|error| format!("{name}: {error}"))?;
    let (low, high) = raw
        .raw_data
        .iter()
        .fold((u16::MAX, u16::MIN), |(low, high), &value| {
            (low.min(value), high.max(value))
        });
    let megapixels = f64::from(raw.width) * f64::from(raw.height) / 1.0e6;
    println!(
        "thumb-cost fixture={name} mp={megapixels:.3} width={} height={} sample_min={low} sample_max={high}",
        raw.width, raw.height
    );
    Ok(Fixture {
        photo: Photo {
            path,
            kind: MediaKind::Raw,
            modified: SystemTime::now(),
            size: bytes.len() as u64,
        },
        megapixels,
        name,
    })
}

fn staged_copy(folder: &Path, source: &Path, name: &str) -> Result<Fixture, String> {
    let path = folder.join(name);
    std::fs::copy(source, &path).map_err(|error| format!("{name}: {error}"))?;
    stage(path, name.to_owned())
}

fn synthetic(folder: &Path) -> Result<Vec<Fixture>, String> {
    let original = folder.join("synthetic-24mp.dng");
    synthetic_dng::write(&original)?;
    println!("thumb-cost source=synthetic note=\"{SYNTHETIC_NOTE}\"");
    (0..SYNTHETIC_COPIES)
        .map(|copy| staged_copy(folder, &original, &format!("synthetic-24mp-{copy}.dng")))
        .collect()
}

fn round(label: &str, workers: usize, fixtures: &[Fixture]) {
    let queue: Mutex<VecDeque<usize>> = Mutex::new((0..fixtures.len()).collect());
    let timings: Mutex<Vec<(usize, f64, bool)>> = Mutex::new(Vec::new());
    let started = Instant::now();
    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| {
                let worker = ThumbnailWorker::new(Default::default());
                loop {
                    let Some(index) = locked(&queue).pop_front() else {
                        break;
                    };
                    let begun = Instant::now();
                    if !worker.request(0, fixtures[index].photo.clone()) {
                        continue;
                    }
                    let Ok((_, _, image)) = worker.events.recv() else {
                        return;
                    };
                    locked(&timings).push((index, millis(begun.elapsed()), image.is_ok()));
                }
            });
        }
    });
    let total = millis(started.elapsed());
    let mut timings = timings.into_inner().unwrap_or_else(PoisonError::into_inner);
    timings.sort_by_key(|(index, _, _)| *index);
    for (index, elapsed, rendered) in timings {
        let fixture = &fixtures[index];
        println!(
            "thumb-cost workers={workers} round={label} fixture={} mp={:.3} rendered={rendered} ms={elapsed:.2}",
            fixture.name, fixture.megapixels
        );
    }
    println!(
        "thumb-cost workers={workers} round={label} photos={} wall_ms={total:.2}",
        fixtures.len()
    );
}

fn embedded(fixtures: &[Fixture]) {
    for fixture in fixtures {
        let Ok(bytes) = std::fs::read(&fixture.photo.path) else {
            continue;
        };
        let rounds: Vec<Option<f64>> = (0..EMBEDDED_ROUNDS)
            .map(|_| {
                let begun = Instant::now();
                let (preview, _) = raw_core::preview::extract_embedded_preview(
                    &bytes,
                    extension(&fixture.photo.path),
                )
                .ok()?;
                let _ = raw_core::preview::resize_long_edge(preview, 256);
                Some(millis(begun.elapsed()))
            })
            .collect();
        match rounds.into_iter().collect::<Option<Vec<f64>>>() {
            Some(times) => println!(
                "thumb-cost embedded fixture={} mp={:.3} min_ms={:.2} median_ms={:.2}",
                fixture.name,
                fixture.megapixels,
                times.iter().copied().fold(f64::INFINITY, f64::min),
                median(times)
            ),
            None => println!(
                "thumb-cost embedded fixture={} no embedded preview in this file",
                fixture.name
            ),
        }
    }
}

fn workers_and_paths() -> Result<(usize, Vec<PathBuf>), String> {
    let mut arguments = std::env::args().skip(1).peekable();
    let workers = if arguments.peek().map(String::as_str) == Some("--workers") {
        arguments.next();
        arguments
            .next()
            .and_then(|value| value.parse::<usize>().ok())
            .filter(|&count| count > 0)
            .ok_or("--workers takes a positive number")?
    } else {
        1
    };
    Ok((workers, arguments.map(PathBuf::from).collect()))
}

fn main() -> Result<(), String> {
    let mut arguments = std::env::args().skip(1);
    if arguments.next().as_deref() == Some("write-dng") {
        let path = arguments.next().ok_or("write-dng takes a path")?;
        synthetic_dng::write(Path::new(&path))?;
        println!("thumb-cost wrote path={path} note=\"{SYNTHETIC_NOTE}\"");
        return Ok(());
    }
    let (workers, given) = workers_and_paths()?;
    let folder = tempfile::tempdir().map_err(|error| error.to_string())?;
    let fixtures = if given.is_empty() {
        synthetic(folder.path())?
    } else {
        given
            .iter()
            .map(|source| {
                let name = source
                    .file_name()
                    .and_then(|name| name.to_str())
                    .ok_or("a RAW path without a file name")?;
                staged_copy(folder.path(), source, name)
            })
            .collect::<Result<Vec<_>, _>>()?
    };
    round("first", workers, &fixtures);
    round("repeat", workers, &fixtures);
    embedded(&fixtures);
    Ok(())
}
