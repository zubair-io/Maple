//! `--seam-constraints <file>` (#4520): a JSON array of user seam
//! constraints in output-canvas pixels, frames named by their index in the
//! sorted input list:
//!
//! ```json
//! [
//!   { "kind": "include", "frame": 2, "x": 1200, "y": 340, "width": 400, "height": 600 },
//!   { "kind": "exclude", "frame": 5, "x": 3100, "y": 500, "width": 250, "height": 700 }
//! ]
//! ```

use std::path::Path;

use maple_pano::seam::{CanvasRect, SeamConstraint};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Kind {
    Include,
    Exclude,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ConstraintEntry {
    kind: Kind,
    frame: usize,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
}

impl From<ConstraintEntry> for SeamConstraint {
    fn from(e: ConstraintEntry) -> Self {
        let rect = CanvasRect {
            x: e.x,
            y: e.y,
            width: e.width,
            height: e.height,
        };
        match e.kind {
            Kind::Include => SeamConstraint::ForceInclude(e.frame, rect),
            Kind::Exclude => SeamConstraint::ForceExclude(e.frame, rect),
        }
    }
}

pub(super) fn parse(json: &str) -> Result<Vec<SeamConstraint>, String> {
    serde_json::from_str::<Vec<ConstraintEntry>>(json)
        .map(|entries| entries.into_iter().map(SeamConstraint::from).collect())
        .map_err(|e| format!("invalid seam constraints: {e}"))
}

pub(super) fn load(path: Option<&Path>) -> Result<Vec<SeamConstraint>, String> {
    path.map_or(Ok(Vec::new()), |p| {
        let json = std::fs::read_to_string(p).map_err(|e| format!("{}: {e}", p.display()))?;
        parse(&json).map_err(|e| format!("{}: {e}", p.display()))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_include_and_exclude_entries() {
        let parsed = parse(
            r#"[{"kind":"include","frame":2,"x":10,"y":20,"width":30,"height":40},
                {"kind":"exclude","frame":0,"x":1,"y":2,"width":3,"height":4}]"#,
        )
        .expect("valid");
        assert_eq!(
            parsed,
            vec![
                SeamConstraint::ForceInclude(
                    2,
                    CanvasRect {
                        x: 10,
                        y: 20,
                        width: 30,
                        height: 40
                    }
                ),
                SeamConstraint::ForceExclude(
                    0,
                    CanvasRect {
                        x: 1,
                        y: 2,
                        width: 3,
                        height: 4
                    }
                ),
            ]
        );
    }

    #[test]
    fn rejects_unknown_kinds_and_fields() {
        assert!(parse(r#"[{"kind":"keep","frame":0,"x":0,"y":0,"width":1,"height":1}]"#).is_err());
        assert!(
            parse(r#"[{"kind":"include","frame":0,"x":0,"y":0,"width":1,"height":1,"w":2}]"#)
                .is_err()
        );
    }
}
