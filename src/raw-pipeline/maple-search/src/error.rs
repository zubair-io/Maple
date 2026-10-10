use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum SearchError {
    #[error("ONNX Runtime is unavailable: {0}")]
    RuntimeUnavailable(String),
    #[error("query embedding failed: {0}")]
    Embedding(String),
    #[error("no query embedder is configured")]
    NoEmbedder,
    #[error("vector payload is {bytes} bytes, expected {expected} for {rows} ids of {dim} f32")]
    VectorShape {
        bytes: usize,
        expected: usize,
        rows: usize,
        dim: usize,
    },
    #[error("vector has {got} dimensions, expected {expected}")]
    Dimension { got: usize, expected: usize },
    #[error("duplicate id {0:?} in the vector id list")]
    DuplicateId(String),
    #[error("text index at {path}: {message}")]
    TextIndex { path: PathBuf, message: String },
    #[error("text index: {0}")]
    Tantivy(#[from] tantivy::TantivyError),
    #[error("invalid config: {0}")]
    Config(String),
}

pub type Result<T> = std::result::Result<T, SearchError>;
