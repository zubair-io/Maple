//! Content-aware seam finding (M2b, spec §5.7, #1179) — a graph-cut
//! (Boykov-Kolmogorov max-flow) alternative to the M2a Voronoi seam
//! (`composite::voronoi_masks`), routing the boundary between
//! neighbouring frames around misaligned or moving content instead of
//! blindly through the deepest-overlap midpoint.
//!
//! # Module map
//!
//! - [`bk`] — the Boykov-Kolmogorov max-flow/min-cut solver itself, a
//!   general grid-graph min-cut engine with no pano-specific knowledge.
//!   Ported from the `pano-core` prototype (PR #17, closed unmerged).
//! - [`pairwise`] — a single 2-image graph-cut seam: builds one BK graph
//!   over an overlap region with the cost function documented on
//!   [`pairwise::cut`], and reads back the min-cut as an A/B partition.
//! - [`labels`] — resolves the N-image case by repeatedly applying
//!   [`pairwise::cut`] as an alpha-expansion move over every overlapping
//!   frame pair, converging on one consistent per-pixel owning frame,
//!   then converts + feathers that into per-frame weight planes.
//! - [`masks`] — the orchestrator [`composite`](crate::composite) calls:
//!   builds a cheap downsampled "seam canvas" (so the alpha-expansion
//!   loop's BK graphs stay small — the ticket's "downsampled overlaps,
//!   <= ~2MP"), warps every frame onto it once, and exposes the result
//!   as [`masks::SeamMasks`] for on-demand bilinear lookup at full
//!   canvas resolution.
//!
//! # Choosing a strategy
//!
//! [`SeamStrategy`] selects between the two. Voronoi stays the default —
//! it's deterministic, content-blind, and exactly what every existing
//! pano-budget ratchet in `test-fixtures/pano-budgets.json` was measured
//! against; graph-cut is opt-in until a follow-up ticket re-baselines
//! those budgets with it as the default. `composite::CompositeReport`
//! and the `maple-cli pano stitch` JSON report both record which one a
//! given run actually used.

pub mod bk;
pub mod labels;
pub mod masks;
pub mod pairwise;

pub use masks::SeamMasks;

/// Which seam-placement algorithm a composite pass used.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SeamStrategy {
    /// Deterministic, content-blind: each pixel goes to whichever
    /// frame's projection sits deepest inside that frame's own bounds
    /// (`composite::voronoi_masks`). The default — see the module doc.
    #[default]
    Voronoi,
    /// Content-aware graph-cut (this module): routes the boundary
    /// around content only one frame shows (a moving subject, a
    /// parallax-shifted edge) instead of cutting through it.
    GraphCut,
}

impl SeamStrategy {
    /// Lowercase label for CLI flags and report JSON (mirrors
    /// `RetentionArg::label` / `LocalAlignArg::label` in the CLI crate).
    pub fn label(self) -> &'static str {
        match self {
            SeamStrategy::Voronoi => "voronoi",
            // Kebab-case to match the CLI's `--seam-strategy graph-cut`
            // value (clap's ValueEnum derive renders variants kebab-case)
            // — the report JSON should read the same as the flag that
            // selected it, not a differently-cased synonym.
            SeamStrategy::GraphCut => "graph-cut",
        }
    }
}
