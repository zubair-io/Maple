//! AVIF samples are normalized to the bitmap recipe's sRGB input contract.
use crate::raster::RasterImage;

pub(super) fn normalizes_to_srgb(header: &super::Dav1dSequenceHeader) -> bool {
    header.pri as u32 == 12 && header.trc as u32 == 13
}

pub(super) fn normalize_colour(image: RasterImage, p3: bool) -> RasterImage {
    use crate::view::encode::TargetPrimaries::{Srgb, P3};
    if p3 {
        image.to_colourspace(P3, Srgb)
    } else {
        image
    }
}

#[cfg(all(test, feature = "avif"))]
mod tests {
    use super::*;
    use crate::view::encode::TargetPrimaries::{Srgb, P3};

    #[test]
    fn p3_avif_reopens_as_srgb_with_alpha_and_matching_colour() {
        for channels in [3, 4] {
            let pixel: Vec<u8> = if channels == 3 {
                vec![210, 75, 40]
            } else {
                vec![210, 75, 40, 137]
            };
            let srgb = RasterImage::from_raw(16, 16, channels, pixel.repeat(256)).unwrap();
            let p3 = srgb.to_colourspace(Srgb, P3);
            let encoded =
                crate::avif::encode_tagged(16, 16, &p3.data, channels, 100, 10, P3).unwrap();
            let container = crate::avif_decode::parse_container(&encoded).unwrap();
            let header = crate::avif_decode::sequence_header(&container.primary_item).unwrap();
            assert_eq!(
                (header.pri as u32, header.trc as u32, header.mtrx as u32),
                (12, 13, 6)
            );
            assert!(
                encoded
                    .windows(11)
                    .any(|box_bytes| box_bytes == b"nclx\0\x0c\0\x0d\0\x06\x80"),
                "container CICP must match the AV1 sequence header"
            );
            let profile = crate::raster_meta::read_sidecars(&encoded).icc.unwrap();
            assert!(profile == crate::icc::profile_for(P3));
            let decoded = crate::avif_decode::decode_avif(&encoded).unwrap();
            assert_eq!(decoded.channels, channels);
            let max_error = srgb
                .data
                .iter()
                .zip(&decoded.data)
                .map(|(a, b)| a.abs_diff(*b))
                .max()
                .unwrap();
            assert!(max_error <= 3, "P3 re-open RGB/alpha error {max_error}");
            if channels == 4 {
                let alpha_header =
                    crate::avif_decode::sequence_header(container.alpha_item.as_deref().unwrap())
                        .unwrap();
                assert_ne!(
                    alpha_header.pri as u32, 12,
                    "alpha must not inherit P3 signalling"
                );
            }
        }
    }

    #[test]
    fn p3_ten_bit_avif_keeps_its_colour_description() {
        let srgb = RasterImage::from_raw(16, 16, 3, [210, 75, 40].repeat(256)).unwrap();
        let p3 = srgb.to_colourspace(Srgb, P3);
        let profile = crate::icc::profile_for(P3);
        let encoded = crate::raster_encode_avif::encode_avif_opts(
            &p3,
            &crate::raster_encode_avif::AvifOptions {
                quality: 100,
                effort: 0,
                bitdepth: 10,
                ..Default::default()
            },
            &crate::raster_encode::EmbeddedMetadata {
                icc: Some(&profile),
                ..Default::default()
            },
        )
        .unwrap();
        let container = crate::avif_decode::parse_container(&encoded).unwrap();
        let header = crate::avif_decode::sequence_header(&container.primary_item).unwrap();
        assert_eq!(
            (header.pri as u32, header.trc as u32, header.hbd),
            (12, 13, 1)
        );
        let decoded = crate::avif_decode::decode_avif(&encoded).unwrap();
        let max_error = srgb
            .data
            .iter()
            .zip(&decoded.data)
            .map(|(a, b)| a.abs_diff(*b))
            .max()
            .unwrap();
        assert!(max_error <= 3, "10-bit P3 re-open colour error {max_error}");
    }

    #[test]
    fn keeping_a_normalized_p3_source_tags_the_srgb_output() {
        let source =
            crate::avif::encode_tagged(16, 16, &[100, 130, 180].repeat(256), 3, 100, 10, P3)
                .unwrap();
        let recipe = crate::raster_recipe::parse_recipe(r#"{"v":1,"input":{"kind":"encoded"},"ops":[],"metadata":{"keep":true},"output":{"format":"png"}}"#).unwrap();
        let output = crate::raster_recipe_exec::run_recipe(&recipe, &source, &[]).unwrap();
        let profile = crate::raster_meta::read_sidecars(&output.bytes)
            .icc
            .unwrap();
        assert!(profile == crate::icc::profile_for(Srgb));
    }
}
