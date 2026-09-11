//! Executor arms for the geometry recipe ops (#3501, task B5): `extract`,
//! `extend`, `rotate`, `flip`, `flop`, `trim`. Split out of
//! `raster_recipe_exec` to keep that file under budget — same pattern as
//! `raster_rotate` being split out of `raster_geometry`.

use crate::error::Result;
use crate::raster::RasterImage;
use crate::raster_geometry::ExtendEdges;
use crate::raster_recipe::Op;
use crate::raster_recipe_exec::bad;
use crate::raster_trim::TrimOptions;

/// Apply one geometry op. Called from `raster_recipe_exec::apply_op` for
/// every `Op::{Extract,Extend,Rotate,Flip,Flop,Trim}` variant — any other
/// variant reaching here is a caller bug.
pub(crate) fn apply_geometry_op(image: RasterImage, op: &Op) -> Result<RasterImage> {
    match op {
        Op::Extract {
            left,
            top,
            width,
            height,
        } => image.extract(*left, *top, *width, *height),
        Op::Extend {
            top,
            bottom,
            left,
            right,
            extend_with,
            background,
        } => {
            if extend_with != "background" {
                return Err(bad(format!(
                    "extendWith '{extend_with}' is not supported; only 'background' is implemented"
                )));
            }
            image.extend(
                ExtendEdges {
                    top: *top,
                    bottom: *bottom,
                    left: *left,
                    right: *right,
                },
                *background,
            )
        }
        Op::Rotate { angle, background } => image.rotate(*angle, *background),
        Op::Flip {} => Ok(image.flip()),
        Op::Flop {} => Ok(image.flop()),
        Op::Trim {
            background,
            threshold,
            margin,
            line_art,
        } => {
            if *line_art {
                return Err(bad(
                    "trim({ lineArt: true }) is not supported; omit it or use a threshold".into(),
                ));
            }
            image.trim(&TrimOptions {
                background: *background,
                threshold: *threshold,
                margin: *margin,
            })
        }
        other => unreachable!("apply_geometry_op called with a non-geometry op: {other:?}"),
    }
}

#[cfg(test)]
mod tests {
    use crate::raster_recipe::parse_recipe;
    use crate::raster_recipe_exec::run_recipe;

    /// 4x2 solid RGBA red, as a raw pixel buffer.
    fn red_rgba() -> Vec<u8> {
        (0..8).flat_map(|_| [255u8, 0, 0, 255]).collect()
    }

    #[test]
    fn geometry_ops_run_in_recipe_order() {
        // 4x2 red, extract the right half, then rotate 90°: 1x2 -> 2x1. Also
        // covers the "at least one 4-channel case" requirement for extract
        // and rotate.
        let out = run_recipe(
            &parse_recipe(
                r#"{"v":1,"input":{"kind":"raw","width":4,"height":2,"channels":4},
                    "ops":[{"op":"extract","left":3,"top":0,"width":1,"height":2},
                           {"op":"rotate","angle":90}],
                    "output":{"format":"raw"}}"#,
            )
            .unwrap(),
            &red_rgba(),
            &[],
        )
        .unwrap();
        assert_eq!((out.width, out.height), (2, 1));
    }

    #[test]
    fn extend_adds_a_transparent_border_through_the_recipe() {
        let out = run_recipe(
            &parse_recipe(
                r#"{"v":1,"input":{"kind":"raw","width":2,"height":1,"channels":3},
                    "ops":[{"op":"extend","left":1,"background":[0,0,0,0]}],
                    "output":{"format":"raw"}}"#,
            )
            .unwrap(),
            &[1, 2, 3, 4, 5, 6],
            &[],
        )
        .unwrap();
        assert_eq!((out.width, out.height, out.channels), (3, 1, 4));
        assert_eq!(&out.bytes[..4], &[0, 0, 0, 0]);
    }

    #[test]
    fn flop_is_reachable_from_the_recipe() {
        let out = run_recipe(
            &parse_recipe(
                r#"{"v":1,"input":{"kind":"raw","width":2,"height":1,"channels":3},
                    "ops":[{"op":"flop"}],"output":{"format":"raw"}}"#,
            )
            .unwrap(),
            &[1, 1, 1, 2, 2, 2],
            &[],
        )
        .unwrap();
        assert_eq!(out.bytes, vec![2, 2, 2, 1, 1, 1]);
    }

    #[test]
    fn flip_is_reachable_from_the_recipe() {
        // 1x2: row 0 is [1,1,1], row 1 is [2,2,2]. Flipped, row 0 of the
        // output is the source's row 1.
        let out = run_recipe(
            &parse_recipe(
                r#"{"v":1,"input":{"kind":"raw","width":1,"height":2,"channels":3},
                    "ops":[{"op":"flip"}],"output":{"format":"raw"}}"#,
            )
            .unwrap(),
            &[1, 1, 1, 2, 2, 2],
            &[],
        )
        .unwrap();
        assert_eq!(out.bytes, vec![2, 2, 2, 1, 1, 1]);
    }

    #[test]
    fn trim_is_reachable_from_the_recipe() {
        // 4x1: white, white, black, white → trims to the single black pixel.
        let out = run_recipe(
            &parse_recipe(
                r#"{"v":1,"input":{"kind":"raw","width":4,"height":1,"channels":3},
                    "ops":[{"op":"trim","threshold":10}],"output":{"format":"raw"}}"#,
            )
            .unwrap(),
            &[255, 255, 255, 255, 255, 255, 0, 0, 0, 255, 255, 255],
            &[],
        )
        .unwrap();
        assert_eq!((out.width, out.height), (1, 1));
        assert_eq!(out.bytes, vec![0, 0, 0]);
    }

    #[test]
    fn an_unsupported_extend_mode_is_named() {
        let recipe = parse_recipe(
            r#"{"v":1,"input":{"kind":"raw","width":1,"height":1,"channels":3},
                "ops":[{"op":"extend","left":1,"extendWith":"mirror"}],"output":{"format":"raw"}}"#,
        )
        .unwrap();
        let err = run_recipe(&recipe, &[1, 2, 3], &[]).unwrap_err();
        assert!(format!("{err}").contains("mirror"), "got: {err}");
    }

    #[test]
    fn an_unsupported_trim_line_art_is_named() {
        let recipe = parse_recipe(
            r#"{"v":1,"input":{"kind":"raw","width":1,"height":1,"channels":3},
                "ops":[{"op":"trim","lineArt":true}],"output":{"format":"raw"}}"#,
        )
        .unwrap();
        let err = run_recipe(&recipe, &[1, 2, 3], &[]).unwrap_err();
        assert!(format!("{err}").contains("lineArt"), "got: {err}");
    }
}
