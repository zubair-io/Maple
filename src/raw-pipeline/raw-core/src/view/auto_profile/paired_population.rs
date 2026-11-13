pub(super) fn p95(mut values: &mut [(f64, usize)]) -> f64 {
    let Some(total) = values.iter().try_fold(0usize, |sum, (value, weight)| {
        (value.is_finite() && *weight > 0)
            .then(|| sum.checked_add(*weight))
            .flatten()
    }) else {
        return f64::INFINITY;
    };
    if total == 0 {
        return f64::INFINITY;
    }
    let mut rank = total / 100 * 95 + (total % 100) * 95 / 100;
    loop {
        let middle = values.len() / 2;
        let (left, pivot, right) =
            values.select_nth_unstable_by(middle, |a, b| a.0.total_cmp(&b.0));
        let left_population: usize = left.iter().map(|(_, weight)| weight).sum();
        if rank < left_population {
            values = left;
        } else if rank < left_population + pivot.1 {
            return pivot.0;
        } else {
            rank -= left_population + pivot.1;
            values = right;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn weighted_rank_matches_explicit_population_and_keeps_unit_weight_rank() {
        for length in [1, 2, 19, 20, 21, 99, 100, 257] {
            for equal in [false, true] {
                let mut rows: Vec<_> = (0..length)
                    .map(|i| {
                        (
                            ((i * 37 + 11) % 31) as f64,
                            if equal { 1 } else { 1 + i % 7 },
                        )
                    })
                    .collect();
                let mut expanded: Vec<_> = rows
                    .iter()
                    .flat_map(|&(v, w)| std::iter::repeat_n(v, w))
                    .collect();
                expanded.sort_by(f64::total_cmp);
                assert_eq!(p95(&mut rows), expanded[expanded.len() * 95 / 100]);
            }
        }
    }
    #[test]
    fn large_cells_cannot_disappear_from_the_tail() {
        let mut rows = vec![(0., 19), (0.2, 2)];
        assert_eq!(p95(&mut rows), 0.2);
        assert_eq!(p95(&mut [(0., usize::MAX)]), 0.);
        assert_eq!(p95(&mut [(0., usize::MAX), (0., 1)]), f64::INFINITY);
        assert_eq!(p95(&mut [(f64::NAN, 1)]), f64::INFINITY);
        assert_eq!(p95(&mut [(0., 0)]), f64::INFINITY);
        assert_eq!(p95(&mut []), f64::INFINITY);
    }
}
