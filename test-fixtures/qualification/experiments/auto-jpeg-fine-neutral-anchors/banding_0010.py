import json
import os
import subprocess
import sys
from pathlib import Path

r = Path(__file__).resolve().parent
repo = Path("/Users/riabuz/.codex/worktrees/color-suite-progress/_Maple")
raw = json.loads((r / "pilot_0010/identity.json").read_text())["raw"]
out = r / "banding_0010"
out.mkdir(exist_ok=False)
env = {k: v for k, v in os.environ.items() if not k.startswith("MAPLE_")}
env["RAYON_NUM_THREADS"] = "4"
rows = []
for label, cli in [
    ("before", r.parent / "auto-jpeg-matched-selection/maple-cli"),
    ("after", r / "maple-cli"),
]:
    folder = out / label
    folder.mkdir()
    with (folder / "producer.log").open("w") as log:
        proc = subprocess.run(
            [
                str(cli),
                "auto-tail-ramp",
                "--raw",
                raw,
                "--out-dir",
                str(folder / "ramps"),
            ],
            env=env,
            check=False,
            stdout=log,
            stderr=subprocess.STDOUT,
        )
    assert proc.returncode == 0
    for ramp in ["neutral", "foliage", "blue", "magenta", "skin"]:
        axis = "luma" if ramp == "neutral" else "chroma"
        with (folder / (ramp + ".log")).open("w") as log:
            proc = subprocess.run(
                [
                    sys.executable,
                    str(repo / "src/scripts/banding_check.py"),
                    str(folder / "ramps" / ramp),
                    "--stage",
                    "18_auto_tail",
                    "--ramp-axis",
                    axis,
                    "--json",
                    str(folder / (ramp + ".json")),
                    "--budgets",
                    str(repo / "test-fixtures/banding_budgets.json"),
                    "--budget-key",
                    f"test_0000_auto2_{ramp}/18_auto_tail/{axis}",
                    "--require-budget",
                ],
                env=env,
                check=False,
                stdout=log,
                stderr=subprocess.STDOUT,
            )
        row = {
            "version": label,
            "fixture": "test_0010",
            "ramp": ramp,
            "exit": proc.returncode,
            "budget_key": f"test_0000_auto2_{ramp}/18_auto_tail/{axis}",
            "qualification": "cross-camera diagnostic using unchanged test0000 reference ceilings; compared before/after, not a new camera-specific budget",
        }
        rows.append(row)
        print(json.dumps(row), flush=True)
        (out / "results.json").write_text(json.dumps(rows, indent=2) + "\n")
