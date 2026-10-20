import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(
    0, "/Users/riabuz/.codex/worktrees/color-suite-progress/_Maple/src/scripts"
)
import auto_profile_match as gate

r = Path(__file__).resolve().parent
repo = Path("/Users/riabuz/.codex/worktrees/color-suite-progress/_Maple")
base = json.loads((r.parent / "auto-embedded-jpeg-source37/summary.json").read_text())
parts = [
    json.loads((r / "leica/summary.json").read_text()),
    json.loads((r / "final-rest/summary.json").read_text()),
]
assert all(
    p["complete"] and p["binary_unchanged"] and p["budget"] == 0.05 for p in parts
)
assert len({p["binary_sha256"] for p in parts}) == 1
assert gate.sha(r / "maple-cli") == parts[0]["binary_sha256"]
rows = sorted(sum([p["cases"] for p in parts], []), key=lambda c: c["fixture"])
assert len(rows) == len({c["fixture"] for c in rows}) == 20
old = {c["fixture"]: c for c in base["cases"]}
receipts = []
for row in rows:
    name = row["fixture"]
    prior = old[name]
    assert row["raw_sha256"] == prior["raw_sha256"] == gate.sha(row["raw"]), name
    folder = r / ("leica" if name == "test_0017" else "final-rest") / name
    if row["status"] == "no-preview":
        proc = subprocess.run(
            [
                str(r / "maple-cli"),
                "extract-preview",
                row["raw"],
                "--out",
                str(r / "unexpected-preview.png"),
            ],
            check=False,
            capture_output=True,
        )
        assert proc.returncode == 3 and prior["status"] == "no-preview", name
    else:
        assert row["status"] == "passed", name
        assert (
            row["reference_sha256"]
            == prior["reference_sha256"]
            == gate.sha(folder / "embedded.png")
        ), name
        assert row["candidate_sha256"] == gate.sha(folder / "auto.png"), name
        result = gate.compare(folder / "auto.png", folder / "embedded.png", 0.05)
        assert all(result[k] == row[k] for k in ["status", "bands", "breaches"]), name
    receipts.append(
        {
            "fixture": name,
            "raw_verified": True,
            "reference_verified": row["status"] == "passed",
            "status": row["status"],
        }
    )
    print("verified", name, flush=True)
assert gate.sha(r / "maple-cli") == parts[0]["binary_sha256"]
counts = {
    s: sum(c["status"] == s for c in rows)
    for s in ["passed", "failed", "no-preview", "error"]
}
assert counts == {"passed": 16, "failed": 0, "no-preview": 4, "error": 0}
summary = {
    "target": "camera-embedded-jpeg",
    "profile": "auto",
    "source_processing_commit": "62afc78711",
    "renderer_tree": subprocess.check_output(
        ["git", "rev-parse", "HEAD:src/raw-pipeline"], cwd=repo, text=True
    ).strip(),
    "pipeline_output_version": 37,
    "auto_fit_model_version": 7,
    "binary_sha256": parts[0]["binary_sha256"],
    "budget": 0.05,
    "coverage": "Complete20fixture set in2disjoint shards from the identical final binary;16JPEG comparisons,4unchanged missing previews.",
    "baseline_counts": base["counts"],
    "counts": counts,
    "cleared": [
        c["fixture"]
        for c in rows
        if c["status"] == "passed" and old[c["fixture"]]["status"] == "failed"
    ],
    "new_failures": [],
    "remaining_failures": [],
    "cases": rows,
    "all_raw_hashes_verified": True,
    "all_16_reference_hashes_identical_to_original_baseline": True,
    "all_16_candidate_hashes_verified": True,
    "all_16_comparisons_recomputed_exactly": True,
    "all_4_no_preview_sentinels_reconfirmed": True,
    "original_inputs_changed": False,
    "verification": receipts,
    "complete": True,
}
(r / "full-fixture-result.json").write_text(json.dumps(summary, indent=2) + "\n")
print("FINAL", counts, "cleared", len(summary["cleared"]), flush=True)
