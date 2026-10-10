//! Exact nearest-neighbour search over an in-memory f32 matrix: every row is
//! scored against the query with a dot product, in parallel, and the best `k`
//! are kept. Rows are L2-normalised on the way in, so the dot product is cosine
//! similarity. Below about a million rows an exact scan is both fast enough and
//! free of the recall loss approximate indexes bring (epic #4460).

use crate::error::{Result, SearchError};
use rayon::prelude::*;
use std::cmp::Ordering;
use std::collections::HashMap;

pub const DIM: usize = 1024;
const LANES: usize = 16;
const GROWTH_ROWS: usize = 1024;
const MIN_ROWS_PER_TASK: usize = 1024;

#[derive(Debug, Clone, PartialEq)]
pub struct ScoredId {
    pub id: String,
    pub score: f32,
}

#[derive(Default)]
pub struct VectorMatrix {
    values: Vec<f32>,
    ids: Vec<String>,
    rows_by_id: HashMap<String, usize>,
}

impl VectorMatrix {
    /// `bytes` is `ids.len()` rows of [`DIM`] little-endian f32, row-major.
    pub fn from_le_bytes(bytes: &[u8], ids: Vec<String>) -> Result<Self> {
        let expected = ids.len() * DIM * 4;
        if bytes.len() != expected {
            return Err(SearchError::VectorShape {
                bytes: bytes.len(),
                expected,
                rows: ids.len(),
                dim: DIM,
            });
        }
        let rows_by_id = index_ids(&ids)?;
        let mut values: Vec<f32> = bytes
            .par_chunks_exact(4)
            .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
            .collect();
        values.par_chunks_exact_mut(DIM).for_each(normalise);
        Ok(Self {
            values,
            ids,
            rows_by_id,
        })
    }

    pub fn len(&self) -> usize {
        self.ids.len()
    }

    pub fn is_empty(&self) -> bool {
        self.ids.is_empty()
    }

    pub fn upsert(&mut self, id: &str, vector: &[f32]) -> Result<()> {
        check_dimension(vector)?;
        let row = match self.rows_by_id.get(id) {
            Some(&row) => row,
            None => {
                if self.values.len() == self.values.capacity() {
                    self.values.reserve_exact(GROWTH_ROWS * DIM);
                }
                self.values.resize(self.values.len() + DIM, 0.0);
                self.ids.push(id.to_owned());
                self.rows_by_id.insert(id.to_owned(), self.ids.len() - 1);
                self.ids.len() - 1
            }
        };
        let slot = &mut self.values[row * DIM..(row + 1) * DIM];
        slot.copy_from_slice(vector);
        normalise(slot);
        Ok(())
    }

    pub fn remove(&mut self, id: &str) -> bool {
        let Some(row) = self.rows_by_id.remove(id) else {
            return false;
        };
        let last = self.ids.len() - 1;
        if row != last {
            self.values
                .copy_within(last * DIM..(last + 1) * DIM, row * DIM);
            self.ids.swap(row, last);
            self.rows_by_id.insert(self.ids[row].clone(), row);
        }
        self.ids.truncate(last);
        self.values.truncate(last * DIM);
        true
    }

    /// The `k` rows most similar to `query`, best first; equal scores are
    /// ordered by id so a result never depends on row order or thread count.
    pub fn nearest(&self, query: &[f32], k: usize) -> Result<Vec<ScoredId>> {
        self.nearest_excluding(query, k, &[])
    }

    /// [`Self::nearest`] over every row except those whose id is in
    /// `excluded`; the excluded rows are skipped during the scan, so they never
    /// take a top-`k` slot from a row that qualifies.
    pub fn nearest_excluding(
        &self,
        query: &[f32],
        k: usize,
        excluded: &[String],
    ) -> Result<Vec<ScoredId>> {
        check_dimension(query)?;
        if k == 0 || self.is_empty() {
            return Ok(Vec::new());
        }
        let mut unit_query = query.to_vec();
        normalise(&mut unit_query);
        let skip = self.row_mask(excluded);
        let rows_per_task =
            (self.len() / (rayon::current_num_threads() * 4)).max(MIN_ROWS_PER_TASK);
        let candidates: Vec<(usize, f32)> = self
            .values
            .par_chunks(rows_per_task * DIM)
            .enumerate()
            .flat_map_iter(|(task, block)| {
                let first_row = task * rows_per_task;
                let scored: Vec<(usize, f32)> = block
                    .chunks_exact(DIM)
                    .enumerate()
                    .map(|(offset, row)| (first_row + offset, row))
                    .filter(|(row_index, _)| !skip.get(*row_index).copied().unwrap_or(false))
                    .map(|(row_index, row)| (row_index, similarity(row, &unit_query)))
                    .collect();
                self.best(scored, k)
            })
            .collect();
        Ok(self
            .best(candidates, k)
            .into_iter()
            .map(|(row, score)| ScoredId {
                id: self.ids[row].clone(),
                score,
            })
            .collect())
    }

    fn row_mask(&self, excluded: &[String]) -> Vec<bool> {
        if excluded.is_empty() {
            return Vec::new();
        }
        let mut mask = vec![false; self.len()];
        excluded
            .iter()
            .filter_map(|id| self.rows_by_id.get(id))
            .for_each(|&row| mask[row] = true);
        mask
    }

    fn rank(&self, a: &(usize, f32), b: &(usize, f32)) -> Ordering {
        b.1.total_cmp(&a.1)
            .then_with(|| self.ids[a.0].cmp(&self.ids[b.0]))
    }

    fn best(&self, mut scored: Vec<(usize, f32)>, k: usize) -> Vec<(usize, f32)> {
        if scored.len() > k {
            scored.select_nth_unstable_by(k - 1, |a, b| self.rank(a, b));
            scored.truncate(k);
        }
        scored.sort_unstable_by(|a, b| self.rank(a, b));
        scored
    }
}

fn index_ids(ids: &[String]) -> Result<HashMap<String, usize>> {
    let mut rows_by_id = HashMap::with_capacity(ids.len());
    for (row, id) in ids.iter().enumerate() {
        if rows_by_id.insert(id.clone(), row).is_some() {
            return Err(SearchError::DuplicateId(id.clone()));
        }
    }
    Ok(rows_by_id)
}

fn check_dimension(vector: &[f32]) -> Result<()> {
    if vector.len() == DIM {
        Ok(())
    } else {
        Err(SearchError::Dimension {
            got: vector.len(),
            expected: DIM,
        })
    }
}

pub(crate) fn normalise(vector: &mut [f32]) {
    let norm = dot(vector, vector).sqrt();
    if norm > 0.0 && norm.is_finite() {
        vector.iter_mut().for_each(|x| *x /= norm);
    }
}

fn similarity(row: &[f32], unit_query: &[f32]) -> f32 {
    let score = dot(row, unit_query);
    if score.is_nan() {
        f32::NEG_INFINITY
    } else {
        score
    }
}

/// Sixteen independent accumulators: a single running f32 sum cannot be
/// vectorised (float addition is not reassociated), sixteen lanes can.
fn dot(a: &[f32], b: &[f32]) -> f32 {
    let mut lanes = [0.0f32; LANES];
    for (xs, ys) in a.chunks_exact(LANES).zip(b.chunks_exact(LANES)) {
        for ((lane, x), y) in lanes.iter_mut().zip(xs).zip(ys) {
            *lane += x * y;
        }
    }
    let tail: f32 = a
        .chunks_exact(LANES)
        .remainder()
        .iter()
        .zip(b.chunks_exact(LANES).remainder())
        .map(|(x, y)| x * y)
        .sum();
    lanes.iter().sum::<f32>() + tail
}

#[cfg(test)]
#[path = "vectors_tests.rs"]
mod tests;
