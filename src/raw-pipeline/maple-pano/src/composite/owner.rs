//! Voronoi ownership of the canvas, run-length encoded per row (#5452).
//! Ownership is piecewise constant along a row — a handful of runs where a
//! dense `u16` map of a 256 MP canvas would be 512 MB.

use super::CropRect;

/// Owner per canvas pixel: a frame index, or `u16::MAX` where no frame
/// covers it.
#[derive(Debug, Clone, PartialEq)]
pub struct OwnerRuns {
    width: u32,
    /// Per row, `(first x, owner)` for each run, in increasing `x`.
    rows: Vec<Vec<(u32, u16)>>,
}

impl OwnerRuns {
    pub(crate) fn new(width: u32) -> Self {
        Self {
            width,
            rows: Vec::new(),
        }
    }

    /// Append the next canvas row's dense owners.
    pub(crate) fn push_row(&mut self, row: &[u16]) {
        debug_assert_eq!(row.len(), self.width as usize);
        let runs = row
            .iter()
            .enumerate()
            .filter(|&(x, &o)| x == 0 || row[x - 1] != o)
            .map(|(x, &o)| (x as u32, o))
            .collect();
        self.rows.push(runs);
    }

    pub(crate) fn at(&self, x: usize, y: usize) -> u16 {
        let runs = &self.rows[y];
        let run = runs.partition_point(|&(start, _)| start as usize <= x) - 1;
        runs[run].1
    }

    /// Does frame `fi` own any pixel in canvas rows `y0..y1`?
    pub(crate) fn owns_any(&self, fi: u16, y0: u32, y1: u32) -> bool {
        self.rows[y0 as usize..y1 as usize]
            .iter()
            .any(|runs| runs.iter().any(|&(_, o)| o == fi))
    }

    /// The owners inside `rect`, for an Auto Cropped output (#5573).
    pub(crate) fn cropped(&self, rect: CropRect) -> Self {
        let (x0, x1) = (rect.x, rect.x + rect.width);
        let rows = self.rows[rect.y as usize..(rect.y + rect.height) as usize]
            .iter()
            .map(|runs| {
                let first = runs.partition_point(|&(start, _)| start <= x0) - 1;
                std::iter::once((0, runs[first].1))
                    .chain(
                        runs[first + 1..]
                            .iter()
                            .take_while(|&&(start, _)| start < x1)
                            .map(|&(start, o)| (start - x0, o)),
                    )
                    .collect()
            })
            .collect();
        Self {
            width: rect.width,
            rows,
        }
    }

    /// The dense row-major map, for callers that write it out whole.
    pub fn to_dense(&self) -> Vec<u16> {
        self.rows
            .iter()
            .flat_map(|runs| {
                runs.iter().enumerate().flat_map(move |(i, &(start, o))| {
                    let end = runs.get(i + 1).map_or(self.width, |&(next, _)| next);
                    std::iter::repeat_n(o, (end - start) as usize)
                })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runs_round_trip_and_answer_lookups() {
        let dense = [
            [u16::MAX, 0, 0, 1, 1, 1],
            [2, 2, 2, 2, 2, 2],
            [0, 1, 0, 1, u16::MAX, u16::MAX],
        ];
        let mut runs = OwnerRuns::new(6);
        dense.iter().for_each(|row| runs.push_row(row));
        assert_eq!(runs.to_dense(), dense.concat());
        for (y, row) in dense.iter().enumerate() {
            for (x, &o) in row.iter().enumerate() {
                assert_eq!(runs.at(x, y), o, "({x},{y})");
            }
        }
        assert!(runs.owns_any(2, 1, 2));
        assert!(!runs.owns_any(2, 2, 3));
        assert!(runs.owns_any(1, 0, 3));
        let rect = CropRect {
            x: 1,
            y: 0,
            width: 4,
            height: 3,
        };
        let cropped: Vec<u16> = dense
            .iter()
            .flat_map(|row| row[1..5].iter().copied())
            .collect();
        assert_eq!(runs.cropped(rect).to_dense(), cropped);
    }
}
