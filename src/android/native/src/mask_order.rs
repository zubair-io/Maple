//! `papp:LayerOrder` keys for the modeled layers (#4427,
//! `docs/xmp-canonical-format.md` § "Cross-type order"). Without a keyed
//! verbatim correction this is raw-core's own rule; with one, read keys stay
//! stable and every other layer lands between its neighbours.
use raw_core::types::Mask;

pub fn container_rank(mask: &Mask) -> usize {
    match mask {
        Mask::Linear { .. } => 0,
        Mask::Radial { .. } => 1,
        Mask::Brush { .. } => 2,
        Mask::Bitmap { .. } | Mask::Everywhere | Mask::Group(_) => 3,
    }
}

/// The six-decimal mask-coordinate codec every writer uses for keys.
pub fn format_key(value: f64) -> String {
    let rounded = (value * 1_000_000.0).round() / 1_000_000.0;
    if rounded == 0.0 {
        return "0".into();
    }
    format!("{rounded:.6}")
        .trim_end_matches('0')
        .trim_end_matches('.')
        .into()
}

pub fn parse_key(raw: &str) -> Option<f64> {
    let text = raw.trim();
    (!text.is_empty() && text.chars().all(|c| "0123456789+-.eE".contains(c)))
        .then(|| text.parse::<f64>().ok())
        .flatten()
        .filter(|v| v.is_finite())
}

/// One key per layer in model order. With nothing keyed kept verbatim, keys
/// are written only when `stamp` (the document would not read back in model
/// order) and number the stack `0…n-1`, as raw-core's writer does.
pub fn assign(stamp: bool, read: &[Option<f64>], verbatim: &[f64]) -> Vec<Option<f64>> {
    if verbatim.is_empty() {
        return (0..read.len())
            .map(|index| stamp.then_some(index as f64))
            .collect();
    }
    let kept = kept_indices(read);
    let mut assigned: Vec<f64> = Vec::with_capacity(read.len());
    for index in 0..read.len() {
        if let (true, Some(key)) = (kept.contains(&index), read[index]) {
            assigned.push(key);
            continue;
        }
        let lower = assigned.last().copied();
        let upper = kept
            .iter()
            .filter(|&&k| k > index)
            .filter_map(|&k| read[k])
            .chain(
                verbatim
                    .iter()
                    .copied()
                    .filter(|v| lower.is_none_or(|l| *v > l)),
            )
            .reduce(f64::min);
        assigned.push(match (lower, upper) {
            (None, None) => 0.0,
            (None, Some(upper)) => upper - 1.0,
            (Some(lower), None) => lower.floor() + 1.0,
            (Some(lower), Some(upper)) => (lower + upper) / 2.0,
        });
    }
    let written = if writable(&assigned, verbatim) {
        assigned
    } else {
        respaced(&assigned, verbatim)
    };
    written.into_iter().map(Some).collect()
}

fn wire(key: f64) -> f64 {
    format_key(key).parse().unwrap_or(f64::NAN)
}

fn writable(keys: &[f64], verbatim: &[f64]) -> bool {
    let written: Vec<f64> = keys.iter().map(|k| wire(*k)).collect();
    written.windows(2).all(|pair| pair[0] < pair[1])
        && keys.iter().zip(&written).all(|(key, wire)| {
            verbatim
                .iter()
                .all(|v| wire != v && (wire < v) == (key < v))
        })
}

fn respaced(keys: &[f64], verbatim: &[f64]) -> Vec<f64> {
    let mut sorted = verbatim.to_vec();
    sorted.sort_by(f64::total_cmp);
    let gaps: Vec<usize> = keys
        .iter()
        .map(|key| sorted.iter().filter(|v| *v < key).count())
        .collect();
    (0..keys.len())
        .map(|index| {
            let gap = gaps[index];
            let members: Vec<usize> = (0..keys.len()).filter(|i| gaps[*i] == gap).collect();
            let count = members.len() as f64;
            let position = members.iter().position(|m| *m == index).unwrap_or(0) as f64;
            let low = (gap > 0).then(|| sorted[gap - 1]);
            let high = sorted.iter().copied().find(|v| low.is_none_or(|l| *v > l));
            match (low, high) {
                (Some(low), Some(high)) => low + (high - low) * (position + 1.0) / (count + 1.0),
                (None, Some(high)) => high - count + position,
                (Some(low), None) => low.floor() + 1.0 + position,
                (None, None) => position,
            }
        })
        .collect()
}

/// A longest strictly increasing run of read keys; ties pick the smallest
/// predecessor and the latest end, so every host keeps the same layers.
fn kept_indices(keys: &[Option<f64>]) -> Vec<usize> {
    let mut length = vec![0usize; keys.len()];
    let mut previous: Vec<Option<usize>> = vec![None; keys.len()];
    for index in 0..keys.len() {
        let Some(key) = keys[index] else { continue };
        let best = (0..index)
            .filter(|j| keys[*j].is_some_and(|k| k < key))
            .max_by(|a, b| {
                (length[*a], std::cmp::Reverse(*a)).cmp(&(length[*b], std::cmp::Reverse(*b)))
            });
        length[index] = 1 + best.map_or(0, |b| length[b]);
        previous[index] = best;
    }
    let Some(&longest) = length.iter().max().filter(|l| **l > 0) else {
        return Vec::new();
    };
    let Some(end) = (0..keys.len()).rev().find(|i| length[*i] == longest) else {
        return Vec::new();
    };
    std::iter::successors(Some(end), |i| previous[*i]).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn without_verbatim_keys_only_an_out_of_order_document_is_numbered() {
        assert_eq!(assign(false, &[None; 3], &[]), vec![None; 3]);
        assert_eq!(
            assign(true, &[Some(4.0), None], &[]),
            vec![Some(0.0), Some(1.0)]
        );
    }

    #[test]
    fn read_keys_stay_put_around_a_verbatim_correction() {
        // A verbatim brush at 1 between two keyed layers; a new layer is added
        // at the bottom and another on top.
        let keys = assign(false, &[None, Some(0.0), Some(2.0), None], &[1.0]);
        assert_eq!(keys, vec![Some(-1.0), Some(0.0), Some(2.0), Some(3.0)]);
        let between = assign(false, &[Some(0.0), None, Some(2.0)], &[1.0]);
        assert_eq!(between, vec![Some(0.0), Some(0.5), Some(2.0)]);
    }

    #[test]
    fn crowded_gaps_are_respaced_inside_the_verbatim_keys() {
        let keys = assign(false, &[Some(0.0000004), None], &[0.0000001, 0.0000012]);
        let written: Vec<f64> = keys.iter().map(|k| wire(k.unwrap())).collect();
        assert!(written[0] < written[1]);
        assert!(keys
            .iter()
            .all(|k| (0.0000001..0.0000012).contains(&k.unwrap())));
        assert_eq!(format_key(2.5), "2.5");
        assert_eq!(format_key(-0.0000001), "0");
        assert_eq!(parse_key(" 3 "), Some(3.0));
        assert_eq!(parse_key("nan"), None);
    }
}
