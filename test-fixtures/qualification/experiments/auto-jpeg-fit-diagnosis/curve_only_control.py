import json
import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(
    0, "/Users/riabuz/.codex/worktrees/color-suite-progress/_Maple/src/scripts"
)
import auto_profile_match as gate

root = Path(__file__).resolve().parent / "curve-only-control"
root.mkdir(exist_ok=False)
suite = Path(
    "/Users/riabuz/.codex/color-suite-evidence/5000/auto-embedded-jpeg-source37"
)
summary = json.loads((suite / "summary.json").read_text())
cli = Path(summary["binary"])
assert gate.sha(cli) == summary["binary_sha256"]
result = {
    "purpose": "Counterfactual only: previous per-channel minimax JPEG curve without residual LUT; no production adoption.",
    "binary_sha256": summary["binary_sha256"],
    "env": {"MAPLE_AUTO1": "1", "MAPLE_DISABLE_AUTO_LUT": "1"},
    "budget": 0.05,
    "cases": [],
}
env = {k: v for k, v in os.environ.items() if not k.startswith("MAPLE_")}
env.update(result["env"])
env.update(RAYON_NUM_THREADS="2", OPENBLAS_NUM_THREADS="1", OMP_NUM_THREADS="1")
for name in ["test_0017", "test_0015", "test_0012"]:
    row = next(x for x in summary["cases"] if x["fixture"] == name)
    assert gate.sha(row["raw"]) == row["raw_sha256"]
    folder = root / name
    folder.mkdir()
    candidate = folder / "auto.png"
    ref = suite / name / "embedded.png"
    assert gate.sha(ref) == row["reference_sha256"]
    with (folder / "render.log").open("w") as log:
        proc = subprocess.run(
            [
                str(cli),
                "render",
                row["raw"],
                "--out",
                str(candidate),
                "--profile",
                "auto",
            ],
            check=False,
            env=env,
            stdout=log,
            stderr=subprocess.STDOUT,
        )
    assert proc.returncode == 0
    measured = gate.compare(candidate, ref, 0.05)
    measured.update(
        fixture=name,
        candidate_sha256=gate.sha(candidate),
        reference_sha256=row["reference_sha256"],
        raw_sha256=row["raw_sha256"],
    )
    assert (
        gate.sha(row["raw"]) == row["raw_sha256"]
        and gate.sha(cli) == result["binary_sha256"]
    )
    result["cases"].append(measured)
    (root / "summary.json").write_text(json.dumps(result, indent=2) + "\n")
    print(name, measured["status"], flush=True)
result["complete"] = True
(root / "summary.json").write_text(json.dumps(result, indent=2) + "\n")
