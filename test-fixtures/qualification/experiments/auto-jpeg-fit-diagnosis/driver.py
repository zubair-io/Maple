import hashlib
import json
import os
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parent
suite = Path(
    "/Users/riabuz/.codex/color-suite-evidence/5000/auto-embedded-jpeg-source37"
)
summary = json.loads((suite / "summary.json").read_text())
cli = root / "maple-cli"


def sha(p):
    with open(p, "rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


identity = {
    "purpose": "Investigate JPEG-match failures; same processing, test-support diagnostic CLI; no ACR renders, no production adoption.",
    "binary_sha256": sha(cli),
    "pipeline_output_version": 37,
    "producer_features": ["test-support", "stage-dump (inactive)"],
    "cases": [],
}
(root / "identity.json").write_text(json.dumps(identity, indent=2) + "\n")
env = {k: v for k, v in os.environ.items() if not k.startswith("MAPLE_")}
env.update(RAYON_NUM_THREADS="2", OPENBLAS_NUM_THREADS="1", OMP_NUM_THREADS="1")
for name in ["test_0017", "test_0015", "test_0012"]:
    row = next(c for c in summary["cases"] if c["fixture"] == name)
    assert sha(row["raw"]) == row["raw_sha256"]
    report = root / f"{name}-fit.txt"
    with (root / f"{name}.log").open("w") as log:
        result = subprocess.run(
            [str(cli), "fit-auto2", "--raw", row["raw"], "--report", str(report)],
            check=False,
            env=env,
            stdout=log,
            stderr=subprocess.STDOUT,
        )
    assert (
        sha(row["raw"]) == row["raw_sha256"] and sha(cli) == identity["binary_sha256"]
    )
    identity["cases"].append(
        {
            "fixture": name,
            "exit": result.returncode,
            "raw_sha256": row["raw_sha256"],
            "report": report.name,
            "report_sha256": sha(report) if report.exists() else None,
        }
    )
    (root / "identity.json").write_text(json.dumps(identity, indent=2) + "\n")
    print(name, "diagnostic complete", result.returncode, flush=True)
identity["complete"] = True
(root / "identity.json").write_text(json.dumps(identity, indent=2) + "\n")
