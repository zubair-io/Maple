#![cfg(feature = "pano")]

use std::process::Command;

#[test]
fn invalid_frame_refuses_with_a_structured_seam_report_before_decode() {
    let dir = tempfile::tempdir().unwrap();
    let request = dir.path().join("constraints.json");
    std::fs::write(&request, r#"{"version":1,"canvas":{"width":100,"height":80},"regions":[{"kind":"include","frame":2,"x":10,"y":10,"width":20,"height":20}]}"#).unwrap();
    let report = dir.path().join("report.json");
    let output = Command::new(env!("CARGO_BIN_EXE_maple-cli"))
        .args([
            "pano",
            "stitch",
            "--features-engine",
            "classical",
            "--strategy",
            "rotation",
            "--seam-strategy",
            "graph-cut",
        ])
        .arg("--seam-constraints")
        .arg(&request)
        .arg("--display")
        .arg(dir.path().join("out.png"))
        .arg("--report")
        .arg(&report)
        .args(["--", "/nonexistent/a.dng", "/nonexistent/b.dng"])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("invalid_seam_constraints"));
    let result: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(report).unwrap()).unwrap();
    assert_eq!(result["refused"]["resource"], "seam_constraints");
    assert!(result["refused"]["message"]
        .as_str()
        .unwrap()
        .contains("frame 2"));
    assert!(!dir.path().join("out.png").exists());
}
