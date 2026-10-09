//! Reciprocal rank fusion: each leg contributes `1 / (RRF_K + rank)` per hit,
//! so a document both legs agree on outranks one that tops only a single leg,
//! and neither leg's raw score scale (cosine vs BM25) has to be calibrated
//! against the other.

use serde::Serialize;
use std::collections::HashMap;

pub const RRF_K: f32 = 60.0;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FusedHit {
    pub id: String,
    pub score: f32,
    pub vector_rank: Option<u32>,
    pub text_rank: Option<u32>,
}

#[derive(Default)]
struct Ranks {
    score: f32,
    vector: Option<u32>,
    text: Option<u32>,
}

fn contribution(rank: u32) -> f32 {
    1.0 / (RRF_K + rank as f32)
}

/// Fuses two ranked id lists (best first). Sorted by score descending, ties
/// broken by id ascending so equal-scoring hits always come back in one order.
pub fn reciprocal_rank_fusion(vector_ids: &[&str], text_ids: &[&str]) -> Vec<FusedHit> {
    let mut by_id: HashMap<&str, Ranks> = HashMap::new();
    for (rank, id) in (1u32..).zip(vector_ids) {
        let entry = by_id.entry(id).or_default();
        if entry.vector.is_none() {
            entry.vector = Some(rank);
            entry.score += contribution(rank);
        }
    }
    for (rank, id) in (1u32..).zip(text_ids) {
        let entry = by_id.entry(id).or_default();
        if entry.text.is_none() {
            entry.text = Some(rank);
            entry.score += contribution(rank);
        }
    }
    let mut fused: Vec<FusedHit> = by_id
        .into_iter()
        .map(|(id, ranks)| FusedHit {
            id: id.to_owned(),
            score: ranks.score,
            vector_rank: ranks.vector,
            text_rank: ranks.text,
        })
        .collect();
    fused.sort_by(|a, b| b.score.total_cmp(&a.score).then_with(|| a.id.cmp(&b.id)));
    fused
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_hit_both_legs_agree_on_outranks_a_single_leg_winner() {
        let fused = reciprocal_rank_fusion(&["a", "b"], &["c", "b"]);
        let ids: Vec<&str> = fused.iter().map(|hit| hit.id.as_str()).collect();
        assert_eq!(ids, ["b", "a", "c"]);
        assert_eq!(fused[0].vector_rank, Some(2));
        assert_eq!(fused[0].text_rank, Some(2));
        assert!((fused[0].score - 2.0 / 62.0).abs() < 1e-7);
    }

    #[test]
    fn scores_follow_one_over_k_plus_rank() {
        let fused = reciprocal_rank_fusion(&["a"], &[]);
        assert_eq!(fused.len(), 1);
        assert!((fused[0].score - 1.0 / 61.0).abs() < 1e-7);
        assert_eq!(fused[0].vector_rank, Some(1));
        assert_eq!(fused[0].text_rank, None);
    }

    #[test]
    fn equal_scores_break_ties_by_id() {
        let fused = reciprocal_rank_fusion(&["zebra"], &["apple"]);
        let ids: Vec<&str> = fused.iter().map(|hit| hit.id.as_str()).collect();
        assert_eq!(ids, ["apple", "zebra"]);
        assert_eq!(fused[0].score, fused[1].score);
    }

    #[test]
    fn a_repeated_id_counts_once_at_its_best_rank() {
        let fused = reciprocal_rank_fusion(&["a", "a"], &[]);
        assert_eq!(fused.len(), 1);
        assert_eq!(fused[0].vector_rank, Some(1));
        assert!((fused[0].score - 1.0 / 61.0).abs() < 1e-7);
    }

    #[test]
    fn empty_legs_fuse_to_nothing() {
        assert!(reciprocal_rank_fusion(&[], &[]).is_empty());
    }
}
