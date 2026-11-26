//! Headless timing harness for #5970 (#6043). Opens one RAW on the
//! application's worker, without a window, and writes a perf row: cold open,
//! slider-tick latency and cancellation latency on the resident GPU path and
//! on the CPU fallback, and peak resident memory. Frame presentation and input
//! dispatch are outside it. The row qualifies as a timing measurement only
//! under the conditions `record::disqualifiers` lists.
mod completion;
mod drive;
mod record;

use std::path::PathBuf;
use std::process::ExitCode;

fn main() -> ExitCode {
    let mut arguments = std::env::args_os().skip(1).map(PathBuf::from);
    let (Some(raw), Some(out), None) = (arguments.next(), arguments.next(), arguments.next())
    else {
        eprintln!("usage: perf-harness <raw> <row.json>");
        return ExitCode::from(2);
    };
    let written = record::measure(&raw, drive::Options::default())
        .and_then(|row| record::write(&row, &out).map(|()| row));
    match written {
        Ok(row) => {
            println!(
                "Wrote {}: {} on {} ({})",
                out.display(),
                row.fixture,
                row.adapter.gpu,
                row.host.device_id
            );
            if row.timing_qualifies {
                println!("Timing qualifies as a Linux hardware measurement.");
            } else {
                println!(
                    "Timing does NOT qualify: {}.",
                    row.timing_disqualifiers.join("; ")
                );
            }
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("perf-harness: {error}");
            ExitCode::FAILURE
        }
    }
}
