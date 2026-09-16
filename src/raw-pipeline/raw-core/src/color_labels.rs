//! Culling metadata wire vocabulary, shared by the platform XMP adapters.
//!
//! These labels have no pixel-processing meaning. Keep their order and exact
//! lowercase spelling stable: both orange and purple exist in stored sidecars.
pub const COLOR_LABELS: [&str; 6] = ["red", "orange", "yellow", "green", "blue", "purple"];

#[cfg(test)]
mod tests {
    use super::COLOR_LABELS;

    #[test]
    fn preserves_existing_sidecar_vocabulary() {
        assert_eq!(
            COLOR_LABELS,
            ["red", "orange", "yellow", "green", "blue", "purple"]
        );
    }
}
