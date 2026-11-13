//! The report's `edges` block (#5574): what Boundary Warp and Auto Crop
//! did. Strengths are percents, the slider's own scale.

use maple_pano::boundary_warp::BoundaryWarpStatus;
use maple_pano::stitch::EdgesReport;
use serde_json::{json, Value};

pub(super) fn edges_report(requested_pct: f64, auto_crop: bool, edges: &EdgesReport) -> Value {
    let (width, height) = edges.output;
    let warp = edges.boundary_warp.as_ref();
    let status = warp.map_or(BoundaryWarpStatus::Off, |w| w.status);
    let crop = edges.auto_crop.as_ref();
    json!({
        "output": { "width": width, "height": height },
        "uncovered_px": edges.uncovered_px,
        "boundary_warp": {
            "requested": requested_pct,
            "applied": warp.map_or(0.0, |w| w.applied * 100.0),
            "status": status,
            "max_stretch": warp.map(|w| w.max_stretch),
            "min_jacobian": warp.map(|w| w.min_jacobian),
            "predicted_coverage": warp.map(|w| w.predicted_coverage),
            "solve_ms": warp.map(|w| w.solve_ms),
        },
        "auto_crop": {
            "requested": auto_crop,
            "rect": crop.and_then(|c| c.rect).map(|r| json!({
                "x": r.x, "y": r.y, "width": r.width, "height": r.height,
            })),
            "invalid_px": crop.map(|c| c.invalid_px),
        },
    })
}

/// `report` with `block` inserted under `key`.
pub(super) fn with_block(report: Value, key: &str, block: Value) -> Value {
    match report {
        Value::Object(mut fields) => {
            fields.insert(key.into(), block);
            Value::Object(fields)
        }
        other => other,
    }
}

/// `--boundary-warp`: a finite percent in `[0, 100]`.
pub(super) fn parse_strength(value: &str) -> Result<f64, String> {
    value
        .parse::<f64>()
        .ok()
        .filter(|v| (0.0..=100.0).contains(v))
        .ok_or_else(|| format!("expected a percent from 0 to 100, got {value:?}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strength_accepts_only_percents() {
        assert_eq!(parse_strength("0"), Ok(0.0));
        assert_eq!(parse_strength("37.5"), Ok(37.5));
        assert_eq!(parse_strength("100"), Ok(100.0));
        for bad in ["-1", "100.1", "NaN", "inf", "x"] {
            assert!(parse_strength(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn an_off_warp_reports_off_with_null_metrics() {
        let block = edges_report(
            0.0,
            false,
            &EdgesReport {
                boundary_warp: None,
                auto_crop: None,
                uncovered_px: 12,
                output: (40, 30),
            },
        );
        assert_eq!(block["boundary_warp"]["status"], "off");
        assert_eq!(block["boundary_warp"]["applied"], 0.0);
        assert!(block["boundary_warp"]["max_stretch"].is_null());
        assert_eq!(block["auto_crop"]["requested"], false);
        assert!(block["auto_crop"]["rect"].is_null());
        assert_eq!(block["output"]["width"], 40);
    }
}
