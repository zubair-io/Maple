//! A Tantivy collector that keeps every hit scoring at or above a floor.
//!
//! `TopDocs` cuts at `limit` by score and then by internal doc address, so
//! when equal scores straddle the cut (identical captions are common) which
//! of them survive depends on insertion order. Collecting everything down to
//! the boundary score instead lets the caller break those ties by id.

use tantivy::collector::{Collector, SegmentCollector};
use tantivy::{DocAddress, DocId, Score, SegmentOrdinal, SegmentReader};

pub(crate) struct ScoreFloor(pub Score);

pub(crate) struct SegmentScoreFloor {
    segment: SegmentOrdinal,
    floor: Score,
    hits: Vec<(Score, DocAddress)>,
}

impl Collector for ScoreFloor {
    type Fruit = Vec<(Score, DocAddress)>;
    type Child = SegmentScoreFloor;

    fn for_segment(
        &self,
        segment: SegmentOrdinal,
        _reader: &SegmentReader,
    ) -> tantivy::Result<SegmentScoreFloor> {
        Ok(SegmentScoreFloor {
            segment,
            floor: self.0,
            hits: Vec::new(),
        })
    }

    fn requires_scoring(&self) -> bool {
        true
    }

    fn merge_fruits(
        &self,
        segment_fruits: Vec<Vec<(Score, DocAddress)>>,
    ) -> tantivy::Result<Vec<(Score, DocAddress)>> {
        Ok(segment_fruits.into_iter().flatten().collect())
    }
}

impl SegmentCollector for SegmentScoreFloor {
    type Fruit = Vec<(Score, DocAddress)>;

    fn collect(&mut self, doc: DocId, score: Score) {
        if score >= self.floor {
            self.hits.push((score, DocAddress::new(self.segment, doc)));
        }
    }

    fn harvest(self) -> Vec<(Score, DocAddress)> {
        self.hits
    }
}
