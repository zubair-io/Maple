#[cfg(test)]
mod preview_tests {
    use super::super::preview::extract_preview;
    use std::path::Path;

    #[test]
    #[cfg_attr(not(feature = "fixtures"), ignore)]
    fn test_0017_extracts_jpeg_preview() {
        let path = Path::new("../../test-fixtures/raws/test_0017.dng");
        let preview = extract_preview(path).expect("test_0017 has an embedded JPEG");
        assert!(preview.width() >= 256, "preview too small: {}", preview.width());
        assert!(preview.height() >= 256, "preview too small: {}", preview.height());
    }

    #[test]
    fn missing_file_returns_none_not_panic() {
        let path = Path::new("/nonexistent/path.dng");
        assert!(extract_preview(path).is_none());
    }
}
