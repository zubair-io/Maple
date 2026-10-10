//! In-process hybrid search for the Self Hosted API (epic #4460): a bge-m3
//! query embedding, an exact cosine scan over the library's document vectors,
//! a Tantivy BM25 keyword leg, and reciprocal rank fusion of the two.
//!
//! Linked only into the API's bun:ffi dylib (raw-ffi's `search` feature).

mod embedder;
mod engine;
mod error;
mod fusion;
mod score_floor;
mod terms;
mod text_index;
mod vectors;

pub use embedder::{EmbedderConfig, QueryEmbedder, MAX_TOKENS};
pub use engine::{fuse, SearchConfig, SearchEngine, LEG_DEPTH};
pub use error::{Result, SearchError};
pub use fusion::{reciprocal_rank_fusion, FusedHit, RRF_K};
pub use terms::{parse_text_query, TextQuery, MAX_TERMS};
pub use text_index::TextIndex;
pub use vectors::{ScoredId, VectorMatrix, DIM};
