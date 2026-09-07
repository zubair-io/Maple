//! Scope statistics (#3272, spec §4/§5.4): the CPU producer and parity oracle
//! for the GPU vectorscope pass. Display-referred by definition — callers hand
//! in the display-ENCODED image (the values the dither quantizes), never a
//! scene-linear one.

pub mod snapshot;
pub mod vectorscope;
pub use snapshot::{
    cell_span, snapshot_dims, snapshot_image, snapshot_rgba_f32, ScopeSnapshot,
    SCOPE_SNAPSHOT_MAX_DIM,
};
pub use vectorscope::{
    bin_index, cb_cr_rec709, vectorscope_histogram, vectorscope_histogram_rgba,
    VectorscopeHistogram, VECTORSCOPE_BINS, WEIGHT_SCALE,
};
