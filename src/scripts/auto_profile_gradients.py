"""Gate each RAW's AMaZE Auto fit against the existing five ramp budgets."""

import hashlib
import json
import math
import subprocess
import sys
from pathlib import Path

RAMPS = ("neutral", "foliage", "blue", "magenta", "skin")
REPO = Path(__file__).resolve().parents[2]


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def check(cli, raw, folder, env):
    out = folder / "gradients"
    out.mkdir(exist_ok=False)
    ramps = out / "ramps"
    with (out / "producer.log").open("w") as log:
        producer = subprocess.run(
            [str(cli), "auto-tail-ramp", "--raw", str(raw), "--out-dir", str(ramps)],
            check=False,
            env=env,
            stdout=log,
            stderr=subprocess.STDOUT,
        )
    if producer.returncode:
        raise RuntimeError(
            f"Auto gradient producer exited {producer.returncode}; "
            "a maple-cli built with stage-dump is required; see gradients/producer.log"
        )
    provenance_path = ramps / "fit-provenance.json"
    provenance = json.loads(provenance_path.read_text())
    dimensions = provenance.get("fit_dimensions", [])
    if (
        provenance.get("demosaic") != "amaze"
        or len(dimensions) != 2
        or not all(isinstance(v, int) and v > 0 for v in dimensions)
    ):
        raise ValueError("gradient producer did not document a native AMaZE fit")
    budgets_path = REPO / "test-fixtures/banding_budgets.json"
    budgets = json.loads(budgets_path.read_text())
    budgets = budgets.get("fixtures", budgets)
    records = []
    for name in RAMPS:
        axis = "luma" if name == "neutral" else "chroma"
        key = f"test_0000_auto2_{name}/18_auto_tail/{axis}"
        report_path = out / f"{name}.json"
        with (out / f"{name}.log").open("w") as log:
            result = subprocess.run(
                [
                    sys.executable,
                    str(REPO / "src/scripts/banding_check.py"),
                    str(ramps / name),
                    "--stage",
                    "18_auto_tail",
                    "--ramp-axis",
                    axis,
                    "--json",
                    str(report_path),
                    "--budgets",
                    str(budgets_path),
                    "--budget-key",
                    key,
                    "--require-budget",
                ],
                check=False,
                env=env,
                stdout=log,
                stderr=subprocess.STDOUT,
            )
        if result.returncode not in (0, 1):
            raise RuntimeError(
                f"{name} gradient measurement exited {result.returncode}"
            )
        report = json.loads(report_path.read_text())
        if (
            key not in budgets
            or report.get("budget") != budgets[key]
            or report.get("budget_key") != key
            or report.get("stage") != "18_auto_tail"
            or report.get("ramp_axis") != axis
            or report.get("passed") is not (result.returncode == 0)
        ):
            raise ValueError(f"{name} gradient report does not match required gate")
        metrics = {**report["second_difference"], **report["flat_run"]}
        if not all(math.isfinite(metrics[k]) for k in budgets[key]):
            raise ValueError(f"{name} gradient metrics are nonfinite")
        measured_pass = all(metrics[k] <= limit for k, limit in budgets[key].items())
        if measured_pass != report["passed"]:
            raise ValueError(f"{name} gradient status contradicts measured values")
        records.append(
            {
                "name": name,
                "budget_key": key,
                "passed": measured_pass,
                "metrics": metrics,
                "report_sha256": sha(report_path),
            }
        )
    return {
        "status": "passed" if all(r["passed"] for r in records) else "failed",
        "provenance_sha256": sha(provenance_path),
        "budgets_sha256": sha(budgets_path),
        "implementation_sha256": sha(__file__),
        "checker_sha256": sha(REPO / "src/scripts/banding_check.py"),
        "ramps": records,
    }
