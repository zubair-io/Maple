use crate::embedder::{EmbedderConfig, QueryEmbedder};
use crate::error::{Result, SearchError};
use crate::fusion::{reciprocal_rank_fusion, FusedHit};
use crate::terms::{parse_text_query, TextQuery};
use crate::text_index::TextIndex;
use crate::vectors::{ScoredId, VectorMatrix};
use serde::Deserialize;
use std::path::PathBuf;
use std::sync::{RwLock, RwLockReadGuard, RwLockWriteGuard};

/// How many hits each leg contributes to fusion.
pub const LEG_DEPTH: usize = 100;

/// `embedder` is optional so a caller that already holds a query vector (and
/// tests, which cannot ship a 2 GB model) can use the engine without one.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SearchConfig {
    pub index_dir: PathBuf,
    #[serde(default)]
    pub embedder: Option<EmbedderConfig>,
}

impl SearchConfig {
    pub fn from_json(json: &str) -> Result<Self> {
        serde_json::from_str(json).map_err(|e| SearchError::Config(e.to_string()))
    }
}

pub struct SearchEngine {
    embedder: Option<QueryEmbedder>,
    vectors: RwLock<VectorMatrix>,
    text: TextIndex,
}

impl SearchEngine {
    pub fn open(config: &SearchConfig) -> Result<Self> {
        let text = TextIndex::open(&config.index_dir)?;
        let embedder = config
            .embedder
            .as_ref()
            .map(QueryEmbedder::open)
            .transpose()?;
        Ok(Self {
            embedder,
            vectors: RwLock::default(),
            text,
        })
    }

    /// Replaces the whole vector matrix; see [`VectorMatrix::from_le_bytes`].
    pub fn load_vectors(&self, bytes: &[u8], ids: Vec<String>) -> Result<usize> {
        let matrix = VectorMatrix::from_le_bytes(bytes, ids)?;
        let rows = matrix.len();
        *self.write_vectors() = matrix;
        Ok(rows)
    }

    pub fn vector_count(&self) -> usize {
        self.read_vectors().len()
    }

    pub fn text_count(&self) -> u64 {
        self.text.num_docs()
    }

    pub fn embed_query(&self, query: &str) -> Result<Vec<f32>> {
        self.embedder
            .as_ref()
            .ok_or(SearchError::NoEmbedder)?
            .embed(query)
    }

    /// The fused top `k` for `query`. A blank query, or one with no positive
    /// term (`???`, `-boat`), finds nothing and is never embedded.
    pub fn search(&self, query: &str, k: usize) -> Result<Vec<FusedHit>> {
        let parsed = parse_text_query(query);
        if !matches!(parsed, TextQuery::Terms { .. }) {
            return Ok(Vec::new());
        }
        let vector = self.embed_query(query)?;
        self.search_parsed(&parsed, &vector, k)
    }

    /// [`Self::search`] with a caller-supplied query vector instead of the
    /// embedder's.
    pub fn search_with_vector(
        &self,
        query: &str,
        vector: &[f32],
        k: usize,
    ) -> Result<Vec<FusedHit>> {
        self.search_parsed(&parse_text_query(query), vector, k)
    }

    fn search_parsed(&self, parsed: &TextQuery, vector: &[f32], k: usize) -> Result<Vec<FusedHit>> {
        if !matches!(parsed, TextQuery::Terms { .. }) {
            return Ok(Vec::new());
        }
        let (vector_hits, text_hits) =
            rayon::join(|| self.vector_leg(parsed, vector), || self.text_leg(parsed));
        Ok(fuse(&vector_hits?, &text_hits?, k))
    }

    /// Nearest [`LEG_DEPTH`] rows to `vector`, minus any whose text contains
    /// a term the query excluded with `-`.
    pub fn vector_leg(&self, parsed: &TextQuery, vector: &[f32]) -> Result<Vec<ScoredId>> {
        let hits = self.read_vectors().nearest(vector, LEG_DEPTH)?;
        let excluded = match parsed {
            TextQuery::Terms { excluded, .. } if !excluded.is_empty() => excluded,
            _ => return Ok(hits),
        };
        let ids: Vec<&str> = hits.iter().map(|hit| hit.id.as_str()).collect();
        let unwanted = self.text.ids_matching_any(excluded, &ids)?;
        Ok(hits
            .into_iter()
            .filter(|hit| !unwanted.contains(&hit.id))
            .collect())
    }

    pub fn text_leg(&self, parsed: &TextQuery) -> Result<Vec<ScoredId>> {
        self.text.search(parsed, LEG_DEPTH)
    }

    /// Vector changes apply at once; text changes become visible on
    /// [`Self::commit`].
    pub fn upsert(&self, id: &str, vector: Option<&[f32]>, text: Option<&str>) -> Result<()> {
        if let Some(vector) = vector {
            self.write_vectors().upsert(id, vector)?;
        }
        if let Some(text) = text {
            self.text.upsert(id, text)?;
        }
        Ok(())
    }

    pub fn delete(&self, id: &str) {
        self.write_vectors().remove(id);
        self.text.delete(id);
    }

    /// Stages removal of every text document — the first step of a full
    /// rebuild (clear, upsert each row, commit). Searches keep the old
    /// contents until the commit.
    pub fn clear_text(&self) -> Result<()> {
        self.text.clear()
    }

    pub fn commit(&self) -> Result<()> {
        self.text.commit()
    }

    pub fn rebuild_text<'a>(
        &self,
        docs: impl IntoIterator<Item = (&'a str, &'a str)>,
    ) -> Result<u64> {
        self.text.rebuild(docs)
    }

    fn read_vectors(&self) -> RwLockReadGuard<'_, VectorMatrix> {
        self.vectors
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn write_vectors(&self) -> RwLockWriteGuard<'_, VectorMatrix> {
        self.vectors
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

pub fn fuse(vector_hits: &[ScoredId], text_hits: &[ScoredId], k: usize) -> Vec<FusedHit> {
    let mut fused = reciprocal_rank_fusion(&hit_ids(vector_hits), &hit_ids(text_hits));
    fused.truncate(k);
    fused
}

fn hit_ids(hits: &[ScoredId]) -> Vec<&str> {
    hits.iter().map(|hit| hit.id.as_str()).collect()
}

#[cfg(test)]
#[path = "engine_tests.rs"]
mod tests;
