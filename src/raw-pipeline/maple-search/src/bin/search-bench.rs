//! Replays a query set through every search stage and prints per-stage
//! latency percentiles — the shape of the 2026-10-09 audit harness, so the
//! child-process cut-over (#4463) can be checked against the same numbers.
//!
//! Inputs: `--vectors` (N × 1024 little-endian f32), `--ids` (N lines, same
//! order), `--texts` (TSV `id<TAB>text`), `--queries` (one per line).

use clap::Parser;
use maple_search::{
    fuse, parse_text_query, EmbedderConfig, FusedHit, SearchConfig, SearchEngine, TextQuery,
};
use serde::Serialize;
use std::path::PathBuf;
use std::time::Instant;

#[derive(Parser)]
struct Args {
    #[arg(long)]
    vectors: PathBuf,
    #[arg(long)]
    ids: PathBuf,
    #[arg(long)]
    texts: PathBuf,
    #[arg(long)]
    queries: PathBuf,
    #[arg(long)]
    index_dir: PathBuf,
    #[arg(long)]
    model_cache_dir: PathBuf,
    #[arg(long)]
    ort_dylib: Option<PathBuf>,
    #[arg(long)]
    intra_threads: Option<usize>,
    #[arg(long)]
    rebuild: bool,
    #[arg(long, default_value_t = 30)]
    k: usize,
    #[arg(long)]
    out: Option<PathBuf>,
}

#[derive(Serialize)]
struct QueryRun {
    query: String,
    embed_ms: f64,
    vector_ms: f64,
    text_ms: f64,
    fuse_ms: f64,
    total_ms: f64,
    vector_hits: usize,
    text_hits: usize,
    fused: Vec<FusedHit>,
}

fn millis_since(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1e3
}

fn read_lines(path: &PathBuf) -> Result<Vec<String>, Box<dyn std::error::Error>> {
    Ok(std::fs::read_to_string(path)?
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(str::to_owned)
        .collect())
}

fn percentile(sorted: &[f64], fraction: f64) -> f64 {
    let index = ((sorted.len() as f64 - 1.0) * fraction).round() as usize;
    sorted[index]
}

fn print_stage(name: &str, values: impl Iterator<Item = f64>) {
    let mut sorted: Vec<f64> = values.collect();
    sorted.sort_by(f64::total_cmp);
    println!(
        "{name:<8} median {:7.2} ms   p95 {:7.2} ms   max {:7.2} ms",
        percentile(&sorted, 0.5),
        percentile(&sorted, 0.95),
        sorted[sorted.len() - 1]
    );
}

fn run_query(engine: &SearchEngine, query: &str, k: usize) -> maple_search::Result<QueryRun> {
    let start = Instant::now();
    let parsed = parse_text_query(query);
    let searchable = matches!(parsed, TextQuery::Terms { .. });
    let vector = if searchable {
        engine.embed_query(query)?
    } else {
        Vec::new()
    };
    let embed_ms = millis_since(start);
    let stage = Instant::now();
    let vector_hits = if searchable {
        engine.vector_leg(&parsed, &vector)?
    } else {
        Vec::new()
    };
    let vector_ms = millis_since(stage);
    let stage = Instant::now();
    let text_hits = engine.text_leg(&parsed)?;
    let text_ms = millis_since(stage);
    let stage = Instant::now();
    let fused = fuse(&vector_hits, &text_hits, k);
    let fuse_ms = millis_since(stage);
    Ok(QueryRun {
        query: query.to_owned(),
        embed_ms,
        vector_ms,
        text_ms,
        fuse_ms,
        total_ms: millis_since(start),
        vector_hits: vector_hits.len(),
        text_hits: text_hits.len(),
        fused,
    })
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();
    let start = Instant::now();
    let engine = SearchEngine::open(&SearchConfig {
        index_dir: args.index_dir.clone(),
        embedder: Some(EmbedderConfig {
            model_cache_dir: args.model_cache_dir.clone(),
            ort_dylib_path: args.ort_dylib.clone(),
            intra_threads: args.intra_threads,
        }),
    })?;
    eprintln!("model + index open: {:.0} ms", millis_since(start));

    let start = Instant::now();
    let rows = engine.load_vectors(&std::fs::read(&args.vectors)?, read_lines(&args.ids)?)?;
    eprintln!(
        "vectors: {rows} rows loaded in {:.0} ms",
        millis_since(start)
    );

    if args.rebuild || engine.text_count() == 0 {
        let start = Instant::now();
        let tsv = std::fs::read_to_string(&args.texts)?;
        let docs = tsv.lines().filter_map(|line| line.split_once('\t'));
        let count = engine.rebuild_text(docs)?;
        eprintln!(
            "text index: {count} docs built in {:.0} ms",
            millis_since(start)
        );
    }
    eprintln!("text index: {} docs", engine.text_count());

    let queries = read_lines(&args.queries)?;
    if queries.is_empty() {
        return Err("the queries file is empty".into());
    }
    run_query(&engine, "warm-up", args.k)?;
    let runs = queries
        .iter()
        .map(|query| {
            let run = run_query(&engine, query, args.k)?;
            eprintln!(
                "{:48.48}  embed {:6.1}  vector {:6.1}  text {:5.1}  total {:6.1} ms  hits {:3}/{:3}",
                run.query, run.embed_ms, run.vector_ms, run.text_ms, run.total_ms, run.vector_hits,
                run.text_hits
            );
            Ok(run)
        })
        .collect::<maple_search::Result<Vec<QueryRun>>>()?;

    println!(
        "{} queries, {} vectors, {} text docs",
        runs.len(),
        rows,
        engine.text_count()
    );
    print_stage("embed", runs.iter().map(|run| run.embed_ms));
    print_stage("vector", runs.iter().map(|run| run.vector_ms));
    print_stage("text", runs.iter().map(|run| run.text_ms));
    print_stage("fuse", runs.iter().map(|run| run.fuse_ms));
    print_stage("total", runs.iter().map(|run| run.total_ms));
    if let Some(out) = &args.out {
        std::fs::write(out, serde_json::to_string(&runs)?)?;
        eprintln!("wrote {}", out.display());
    }
    Ok(())
}
