#![cfg(feature = "pano")]

use std::process::Command;

#[test]
fn schema_failures_replace_stale_reports_for_preview_and_stitch() {
    let valid = serde_json::json!({"version":1,"canvas":{"width":100,"height":80},"regions":[
        {"kind":"include","frame":1,"x":10,"y":10,"width":20,"height":20}
    ]});
    for preview in [false, true] {
        for field in ["version", "width", "bounds"] {
            let dir = tempfile::tempdir().unwrap();
            let request = dir.path().join("constraints.json");
            let report = dir.path().join("report.json");
            let mut invalid = valid.clone();
            match field {
                "version" => invalid["version"] = serde_json::json!(2),
                "width" => invalid["regions"][0]["width"] = serde_json::json!(0),
                _ => invalid["regions"][0]["x"] = serde_json::json!(100),
            }
            std::fs::write(&request, invalid.to_string()).unwrap();
            std::fs::write(&report, "stale success report").unwrap();
            let output = Command::new(env!("CARGO_BIN_EXE_maple-cli"))
                .args([
                    "pano",
                    "stitch",
                    "--features-engine",
                    "classical",
                    "--seam-strategy",
                    "graph-cut",
                ])
                .arg("--seam-constraints")
                .arg(&request)
                .arg(if preview {
                    "--preview-out"
                } else {
                    "--display"
                })
                .arg(dir.path().join("out.png"))
                .arg("--report")
                .arg(&report)
                .args(["--", "/nonexistent/a.dng", "/nonexistent/b.dng"])
                .output()
                .unwrap();
            assert!(!output.status.success());
            let result: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(report).unwrap())
                    .unwrap_or_else(|e| panic!("preview={preview} {field}: {e}"));
            assert_eq!(result["refused"]["resource"], "seam_constraints");
            assert!(result["refused"]["message"].as_str().is_some());
            assert!(!dir.path().join("out.png").exists());
        }
    }
}
