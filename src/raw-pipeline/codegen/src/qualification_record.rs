//! `qualification-record` — writes (or checks) one evidence record for the
//! capability registry (#2430).
//!
//! A harness wrapper (`tools/qualification/record.sh`) runs a suite, parses
//! its pass/fail/skip counts, and calls this binary, which stamps the
//! record with the facts only the Rust crate knows for certain: the
//! current `PIPELINE_OUTPUT_VERSION`, the sidecar schema version, the
//! source's declared expected case count, and a blake3 hash of the
//! source's declared corpus. The registry generator then judges the record
//! against the same declarations — see
//! `raw_core::capability_registry::judge`.
//!
//! `--check` compares the would-be record's load-bearing fields against the
//! record already committed at `--out` and exits non-zero on any
//! difference (or a missing file). CI uses it so a suite that gained or
//! lost cases, or a corpus that changed, cannot keep a stale record green.

use std::fs;
use std::path::PathBuf;
use std::process::exit;

use clap::Parser;
use raw_core::capability_registry::{
    current_schema_version, hash_corpus, EvidenceRecord, EvidenceSource,
};
use raw_core::PIPELINE_OUTPUT_VERSION;

#[derive(Parser, Debug)]
#[command(
    name = "qualification-record",
    about = "Write or check one capability-registry evidence record"
)]
struct Cli {
    /// Evidence source id (`raw_core::capability_registry::EvidenceSource::id`).
    #[arg(long)]
    source: String,
    /// Backend the suite ran on (must be one the source accepts).
    #[arg(long)]
    backend: String,
    /// Cases the run executed (passed + failed).
    #[arg(long)]
    executed: u32,
    /// Cases that failed.
    #[arg(long, default_value_t = 0)]
    failed: u32,
    /// Cases that were skipped / ignored.
    #[arg(long, default_value_t = 0)]
    skipped: u32,
    /// Repository root the corpus paths resolve against.
    #[arg(long)]
    repo_root: PathBuf,
    /// Record path (`test-fixtures/qualification/<source>.json`).
    #[arg(long)]
    out: PathBuf,
    /// Commit the run was made on (informational).
    #[arg(long, default_value = "")]
    git_sha: String,
    /// RFC 3339 timestamp of the run (informational).
    #[arg(long, default_value = "")]
    recorded_at: String,
    /// The command the harness ran (informational).
    #[arg(long, default_value = "")]
    command: String,
    /// Compare against the committed record instead of writing.
    #[arg(long, default_value_t = false)]
    check: bool,
}

fn main() {
    let cli = Cli::parse();
    let Some(source) = EvidenceSource::from_id(&cli.source) else {
        eprintln!(
            "qualification-record: unknown source `{}`; known: {}",
            cli.source,
            EvidenceSource::ALL
                .iter()
                .map(|s| s.id())
                .collect::<Vec<_>>()
                .join(", ")
        );
        exit(2);
    };
    let corpus_hash = match hash_corpus(&cli.repo_root, source.corpus()) {
        Ok(h) => h,
        Err(e) => {
            eprintln!(
                "qualification-record: cannot hash corpus for `{}`: {e}",
                cli.source
            );
            exit(2);
        }
    };
    let record = EvidenceRecord {
        source,
        backend: cli.backend,
        pipeline_version: PIPELINE_OUTPUT_VERSION,
        schema_version: current_schema_version(),
        corpus_hash,
        expected_cases: source.expected_cases(),
        executed_cases: cli.executed,
        failed_cases: cli.failed,
        skipped_cases: cli.skipped,
        git_sha: cli.git_sha,
        recorded_at: cli.recorded_at,
        command: cli.command,
    };
    let text = serde_json::to_string_pretty(&record.to_json()).expect("record serializes") + "\n";

    if cli.check {
        let committed = fs::read_to_string(&cli.out)
            .map_err(|e| format!("{}: {e}", cli.out.display()))
            .and_then(|t| {
                EvidenceRecord::from_json(&t).map_err(|e| format!("{}: {e}", cli.out.display()))
            });
        match committed {
            Ok(c) if c.load_bearing() == record.load_bearing() => {
                println!(
                    "qualification-record: `{}` matches the committed record ({} of {} cases, {} failed, {} skipped)",
                    source.id(),
                    record.executed_cases,
                    record.expected_cases,
                    record.failed_cases,
                    record.skipped_cases
                );
            }
            Ok(c) => {
                eprintln!(
                    "qualification-record: `{}` DRIFTED from the committed record.\n  committed: {:?}\n  this run:  {:?}\n  Re-record with tools/qualification/record.sh and commit {}.",
                    source.id(),
                    c.load_bearing(),
                    record.load_bearing(),
                    cli.out.display()
                );
                exit(1);
            }
            Err(e) => {
                eprintln!("qualification-record: no usable committed record — {e}");
                exit(1);
            }
        }
        return;
    }

    if let Some(parent) = cli.out.parent() {
        fs::create_dir_all(parent).expect("create record dir");
    }
    fs::write(&cli.out, text).expect("write record");
    println!(
        "qualification-record: wrote {} ({} of {} cases, {} failed, {} skipped, {})",
        cli.out.display(),
        record.executed_cases,
        record.expected_cases,
        record.failed_cases,
        record.skipped_cases,
        record.corpus_hash
    );
}
