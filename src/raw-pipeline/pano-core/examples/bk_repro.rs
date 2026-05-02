//! Stand-alone reproducer for the BK perf hang on heterogeneous-
//! capacity grids.
//!
//! Runs the same 8×4 grid as the unit-test bisection probes but
//! outside cargo's stdout-capturing harness so per-iteration prints
//! flush in real time. Use this to find what's actually happening
//! when BK is "hung."
//!
//! Run with `BK_DEBUG=1 cargo run --release -p pano-core --example bk_repro`.

use std::io::Write;
use std::ops::Range;

use pano_core::seam::bk::{BkGraph, NodeId};

const INF_CAP: i64 = i64::MAX / 4;

fn build_grid(
    cols: u32,
    rows: u32,
    cap_low: i64,
    cap_high: i64,
    cap_terminal: i64,
    rect_x: Range<u32>,
    rect_y: Range<u32>,
) -> BkGraph {
    let n = (cols * rows) as usize;
    let mut g = BkGraph::with_capacity(n, n * 4);
    let ids: Vec<NodeId> = (0..n).map(|_| g.add_node()).collect();
    let in_rect = |x: u32, y: u32| rect_x.contains(&x) && rect_y.contains(&y);
    for y in 0..rows {
        for x in 0..cols {
            let idx = (y * cols + x) as usize;
            if x + 1 < cols {
                let r_idx = idx + 1;
                let cap = if in_rect(x, y) || in_rect(x + 1, y) {
                    cap_high
                } else {
                    cap_low
                };
                g.add_edge(ids[idx], ids[r_idx], cap, cap);
            }
            if y + 1 < rows {
                let d_idx = idx + cols as usize;
                let cap = if in_rect(x, y) || in_rect(x, y + 1) {
                    cap_high
                } else {
                    cap_low
                };
                g.add_edge(ids[idx], ids[d_idx], cap, cap);
            }
            if x == 0 {
                g.add_terminal(ids[idx], cap_terminal, 0);
            } else if x == cols - 1 {
                g.add_terminal(ids[idx], 0, cap_terminal);
            }
        }
    }
    g
}

fn run_case(label: &str, cap_low: i64, cap_high: i64, cap_terminal: i64) {
    println!("\n===== {} =====", label);
    println!(
        "cap_low={}, cap_high={}, cap_terminal={}",
        cap_low, cap_high, cap_terminal
    );
    std::io::stdout().flush().unwrap();
    let mut g = build_grid(8, 4, cap_low, cap_high, cap_terminal, 3..4, 1..2);
    g.set_iter_limit(50);
    g.finalize();
    let t0 = std::time::Instant::now();
    let flow = g.solve();
    let dt = t0.elapsed();
    println!(
        "→ flow={} after {} iters in {:?}",
        flow,
        g.augment_iters(),
        dt
    );
    std::io::stdout().flush().unwrap();
}

fn main() {
    println!(
        "Reproducer: 8×4 grid, source=col 0, sink=col 7, 1×1 rect at (3,1)"
    );
    println!("iter_limit=50 on each case so we always terminate fast");
    std::io::stdout().flush().unwrap();

    // Take case selection from argv[1]: "uniform" / "het2" / "het10" /
    // "het100" / "het1k" / "het3m" / "infu" / "infh"
    let case = std::env::args().nth(1).unwrap_or_else(|| "all".into());
    match case.as_str() {
        "uniform" => run_case("uniform cap=1", 1, 1, 100),
        "het2" => run_case("heterogeneous cap_high=2", 1, 2, 100),
        "het10" => run_case("heterogeneous cap_high=10", 1, 10, 100),
        "het100" => run_case("heterogeneous cap_high=100", 1, 100, 100),
        "het1k" => run_case("heterogeneous cap_high=1000", 1, 1_000, 100),
        "het3m" => run_case(
            "heterogeneous cap_high=3M (T6 production)",
            1,
            3_000_000,
            100,
        ),
        "infu" => run_case("INF terminals + uniform cap=1", 1, 1, INF_CAP),
        "infh" => run_case("INF terminals + heterogeneous cap_high=2", 1, 2, INF_CAP),
        _ => {
            run_case("uniform cap=1", 1, 1, 100);
            run_case("heterogeneous cap_high=2", 1, 2, 100);
            run_case("heterogeneous cap_high=10", 1, 10, 100);
            run_case("heterogeneous cap_high=100", 1, 100, 100);
            run_case("heterogeneous cap_high=1000", 1, 1_000, 100);
            run_case("heterogeneous cap_high=3M (T6 production)", 1, 3_000_000, 100);
            run_case("INF terminals + uniform cap=1", 1, 1, INF_CAP);
            run_case("INF terminals + heterogeneous cap_high=2", 1, 2, INF_CAP);
        }
    }

    println!("\nAll cases complete.");
}
