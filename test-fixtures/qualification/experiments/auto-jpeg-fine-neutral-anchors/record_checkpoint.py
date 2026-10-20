import hashlib
import json
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parent
repo = Path("/Users/riabuz/.codex/worktrees/color-suite-progress/_Maple")
summary = json.loads((root / "full-suite/summary.json").read_text())
assert summary["complete"] and len(summary["cases"]) == 20
identity = json.loads((root / "identity.json").read_text())


def sha(p):
    with Path(p).open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


assert sha(root / "maple-cli") == identity["binary_sha256"] == summary["binary_sha256"]
before = {
    c["fixture"]: c
    for c in json.loads(
        (
            root.parent / "auto-jpeg-matched-selection/full-suite/summary.json"
        ).read_text()
    )["cases"]
}
assert set(before) == {c["fixture"] for c in summary["cases"]}
changes = []
checks = []
key = lambda x: tuple(
    x.get(k) for k in ["metric", "band", "region", "channel", "row", "column"]
)
for case in summary["cases"]:
    name = case["fixture"]
    old = before[name]
    folder = root / "full-suite" / name
    assert sha(case["raw"]) == case["raw_sha256"] == old["raw_sha256"], name
    if case["status"] == "no-preview":
        assert case["fallback"]["status"] == "passed"
        assert case["fallback"]["auto_sha256"] == case["fallback"]["neutral_sha256"]
        checks.append(
            {
                "fixture": name,
                "raw_sha256": case["raw_sha256"],
                "fallback": case["fallback"],
            }
        )
        continue
    assert sha(folder / "auto.png") == case["candidate_sha256"]
    assert (
        sha(folder / "embedded.png")
        == case["reference_sha256"]
        == old["reference_sha256"]
    )
    row = {
        "fixture": name,
        "before": old["status"],
        "after": case["status"],
        "png_changed": old["candidate_sha256"] != case["candidate_sha256"],
        "before_metrics": old["quality"]["metrics"],
        "after_metrics": case["quality"]["metrics"],
        "changes": {},
    }
    for label, prev, now in [
        ("display", old["quality"]["breaches"], case["quality"]["breaches"]),
        (
            "native",
            old["native_absolute"]["breaches"],
            case["native_absolute"]["breaches"],
        ),
        ("bias", old["breaches"], case["breaches"]),
    ]:
        previous = {key(x) for x in prev}
        current = {key(x) for x in now}
        row["changes"][label] = {
            "cleared": [x for x in prev if key(x) not in current],
            "added": [x for x in now if key(x) not in previous],
        }
    changes.append(row)
    checks.append(
        {
            "fixture": name,
            "raw_sha256": case["raw_sha256"],
            "candidate_sha256": case["candidate_sha256"],
            "reference_sha256": case["reference_sha256"],
        }
    )
for p in (root / "source").iterdir():
    if not p.is_file() or p.suffix not in [".py", ".rs"]:
        continue
    rel = (
        "src/scripts/" + p.name
        if p.suffix == ".py"
        else "src/raw-pipeline/raw-core/src/view/auto_profile/" + p.name
    )
    expected = subprocess.check_output(
        ["git", "show", identity["source_commit"] + ":" + rel], cwd=repo
    )
    assert p.read_bytes() == expected, p.name
for fixture in ["0010", "0015"]:
    assert sha(root / ("pilot_" + fixture) / "auto.png") == sha(
        root / "full-suite" / ("test_" + fixture) / "auto.png"
    )
assert (root / "banding_0010/before/neutral.json").read_bytes() == (
    root / "banding_0010/after/neutral.json"
).read_bytes()
import sys

import numpy as np

sys.path.insert(0, str(repo / "src/scripts"))
from banding_check import load_exr_rgb

assert np.array_equal(
    load_exr_rgb(root / "banding_0010/before/ramps/neutral/18_auto_tail.exr"),
    load_exr_rgb(root / "banding_0010/after/ramps/neutral/18_auto_tail.exr"),
)
assert np.array_equal(
    load_exr_rgb(root / "banding_0009/before/ramps/neutral/18_auto_tail.exr"),
    load_exr_rgb(root / "banding_0009/after/ramps/neutral/18_auto_tail.exr"),
)
for fixture in ["0009", "0010"]:
    rows = json.loads((root / ("banding_" + fixture) / "results.json").read_text())
    assert len(rows) == 10
    assert all(row["exit"] == 0 for row in rows if row["ramp"] != "neutral")
assert "100 passed; 0 failed; 6 ignored" in (root / "units.log").read_text()
assert "8 passed; 0 failed" in (root / "host.log").read_text()
assert "7 passed; 0 failed" in (root / "gpu.log").read_text()
assert all(
    x["exit"] == 0 for x in json.loads((root / "banding-results.json").read_text())
)
report = {
    "source_commit": identity["source_commit"],
    "counts": summary["counts"],
    "new_fully_passing_images": [
        r["fixture"]
        for r in changes
        if r["before"] != "passed" and r["after"] == "passed"
    ],
    "previously_passing_images_regressed": [
        r["fixture"]
        for r in changes
        if r["before"] == "passed" and r["after"] != "passed"
    ],
    "cleared_checks": sum(
        len(c["cleared"]) for r in changes for c in r["changes"].values()
    ),
    "new_failing_checks": sum(
        len(c["added"]) for r in changes for c in r["changes"].values()
    ),
    "changed_images": [r["fixture"] for r in changes if r["png_changed"]],
    "exact_fallback_passes": sum(c["status"] == "no-preview" for c in summary["cases"]),
    "all20_raw_hashes_unchanged": True,
    "all16_reference_hashes_unchanged": True,
    "all16_outputs_verified": True,
    "frozen_sources_and_binary_verified": True,
    "pilots_match_physical_suite": True,
    "test0010_neutral_ramp_exactly_equals_prior": True,
    "test0009_neutral_ramp_exactly_equals_prior": True,
    "both_changed_fixture_color_ramps_pass_before_and_after": True,
    "existing_cross_camera_test0010_neutral_ceilings_failure_remains": True,
    "binary_sha256": identity["binary_sha256"],
    "pipeline_output_version": 37,
    "fit_version": 7,
    "tests": {
        "Auto_units_passed": 100,
        "fixture_ignored": 6,
        "physical_host_passed": 8,
        "GPU_LUT_parity_passed": 7,
        "fixed_budget_banding_ramps_passed": 5,
    },
    "complete_goal": False,
    "checks": checks,
}
(root / "all-check-changes.json").write_text(json.dumps(changes, indent=2) + "\n")
(root / "verification.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps({k: v for k, v in report.items() if k != "checks"}), flush=True)
