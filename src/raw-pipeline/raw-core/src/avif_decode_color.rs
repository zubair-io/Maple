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
            P3,
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
    fn recipe_avif(channels: u8, depth: u8, ops: &str, metadata: &str, aux: &[u8]) -> Vec<u8> {
        let recipe = crate::raster_recipe::parse_recipe(&format!(
            r#"{{"v":1,"input":{{"kind":"raw","width":16,"height":16,"channels":{channels}}},"ops":{ops},"metadata":{metadata},"output":{{"format":"avif","quality":100,"effort":0,"bitdepth":{depth}}}}}"#
        )).unwrap();
        let pixel = if channels == 3 {
            vec![210, 75, 40]
        } else {
            vec![210, 75, 40, 137]
        };
        crate::raster_recipe_exec::run_recipe(&recipe, &pixel.repeat(256), aux)
            .unwrap()
            .bytes
    }

    fn assert_recipe_colour(
        bytes: &[u8],
        channels: u8,
        depth: u8,
        primaries: u32,
        profile: Option<&[u8]>,
    ) {
        let container = crate::avif_decode::parse_container(bytes).unwrap();
        let header = crate::avif_decode::sequence_header(&container.primary_item).unwrap();
        assert_eq!(
            (header.pri as u32, header.trc as u32, header.mtrx as u32),
            (primaries, 13, 6)
        );
        assert_eq!(header.hbd, u8::from(depth == 10));
        let nclx = [
            b"nclx".as_slice(),
            &(primaries as u16).to_be_bytes(),
            &[0, 13, 0, 6, 128],
        ]
        .concat();
        let descriptions: Vec<_> = bytes
            .windows(4)
            .enumerate()
            .filter(|(_, b)| *b == b"nclx")
            .map(|(i, _)| &bytes[i..i + 11])
            .collect();
        // The serializer omits CICP only for its exact implicit sRGB default.
        if primaries == 12 || !descriptions.is_empty() {
            assert!(descriptions.iter().all(|b| *b == nclx));
            assert!(!descriptions.is_empty(), "P3 needs explicit container CICP");
        }
        assert_eq!(
            crate::raster_meta::read_sidecars(bytes).icc.as_deref(),
            profile
        );
        let decoded = crate::avif_decode::decode_avif(bytes).unwrap();
        assert_eq!(
            (decoded.width, decoded.height, decoded.channels),
            (16, 16, channels)
        );
        assert_eq!(decoded.data.len(), 256 * usize::from(channels));
        let pixel = if channels == 3 {
            vec![210, 75, 40]
        } else {
            vec![210, 75, 40, 137]
        };
        let max_error = decoded
            .data
            .iter()
            .zip(pixel.repeat(256))
            .map(|(a, b)| a.abs_diff(b))
            .max()
            .unwrap();
        assert!(
            max_error <= 3,
            "recipe re-open colour/alpha error {max_error}"
        );
        if channels == 4 {
            let alpha =
                crate::avif_decode::sequence_header(container.alpha_item.as_deref().unwrap())
                    .unwrap();
            assert_ne!(alpha.pri as u32, 12, "alpha has independent signalling");
        }
    }

    #[test]
    fn custom_p3_icc_recipe_follows_actual_p3_samples() {
        let standard = crate::icc::profile_for(P3);
        let mut custom = standard.clone();
        // ICC header creator signature only: matrix, TRCs, tag offsets and length stay identical.
        custom[80..84].copy_from_slice(b"TEST");
        assert_ne!(custom, standard);
        assert_eq!(&custom[128..], &standard[128..]);
        for channels in [3, 4] {
            for depth in [8, 10] {
                let metadata = format!(r#"{{"icc":{{"off":0,"len":{}}}}}"#, custom.len());
                let ops = r#"[{"op":"toColourspace","space":"display-p3"}]"#;
                let encoded = recipe_avif(channels, depth, ops, &metadata, &custom);
                assert_recipe_colour(&encoded, channels, depth, 12, Some(&custom));
                let standard_metadata =
                    format!(r#"{{"icc":{{"off":0,"len":{}}}}}"#, standard.len());
                let standard_encoded =
                    recipe_avif(channels, depth, ops, &standard_metadata, &standard);
                let custom_item = crate::avif_decode::parse_container(&encoded).unwrap();
                let standard_item = crate::avif_decode::parse_container(&standard_encoded).unwrap();
                assert_eq!(
                    custom_item.primary_item, standard_item.primary_item,
                    "ICC description must not change sample signalling or encoding"
                );
            }
        }
    }

    #[test]
    fn p3_icc_bytes_do_not_convert_srgb_recipe_samples() {
        let profile = crate::icc::profile_for(P3);
        let metadata = format!(r#"{{"icc":{{"off":0,"len":{}}}}}"#, profile.len());
        for channels in [3, 4] {
            for depth in [8, 10] {
                assert_recipe_colour(
                    &recipe_avif(channels, depth, "[]", &metadata, &profile),
                    channels,
                    depth,
                    1,
                    Some(&profile),
                );
            }
        }
    }

    #[test]
    fn named_p3_and_reversed_conversion_follow_actual_samples() {
        for channels in [3, 4] {
            for depth in [8, 10] {
                let named = recipe_avif(channels, depth, "[]", r#"{"iccName":"p3"}"#, &[]);
                assert_recipe_colour(
                    &named,
                    channels,
                    depth,
                    12,
                    Some(&crate::icc::profile_for(P3)),
                );
                let named_override = recipe_avif(
                    channels,
                    depth,
                    r#"[{"op":"toColourspace","space":"p3"}]"#,
                    r#"{"iccName":"srgb"}"#,
                    &[],
                );
                assert_recipe_colour(
                    &named_override,
                    channels,
                    depth,
                    1,
                    Some(&crate::icc::profile_for(Srgb)),
                );
                let reversed = recipe_avif(
                    channels,
                    depth,
                    r#"[{"op":"toColourspace","space":"p3"},{"op":"toColourspace","space":"srgb"}]"#,
                    r#"{"iccName":"srgb"}"#,
                    &[],
                );
                assert_recipe_colour(
                    &reversed,
                    channels,
                    depth,
                    1,
                    Some(&crate::icc::profile_for(Srgb)),
                );
            }
        }
    }
    #[test]
    fn untagged_default_recipe_retains_srgb_samples() {
        for channels in [3, 4] {
            for depth in [8, 10] {
                assert_recipe_colour(
                    &recipe_avif(channels, depth, "[]", "{}", &[]),
                    channels,
                    depth,
                    1,
                    None,
                );
            }
        }
    }
}
