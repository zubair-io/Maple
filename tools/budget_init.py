#!/usr/bin/env python3
"""Convert the test_color_pipeline.sh table output into budgets.json.

Reads the column-aligned per-case rows from stdin, parses fixture/case/mean/p95/max/bR/bG/bB,
and emits a JSON budget table with each numeric ceiling rounded UP slightly to give a
small ratchet headroom (so a 0.1 ΔE noise wobble on a re-run doesn't flip a PASS to FAIL).

Headroom: ceil(mean * 1.05), ceil(p95 * 1.05), ceil(max * 1.05), abs(bias) * 1.1, all
clamped to {0.5, 1.0, 1.0, 0.005} as floors so a perfect-zero case still has *some* room.

Usage: tools/budget_init.py < /tmp/budgets-raw.txt > test-fixtures/budgets.json
"""

import json
import math
import re
import sys
from collections import defaultdict

# Match a case row from src/scripts/test_color_pipeline.sh's output:
#   test_0000    baseline                 8.32M    8.41 12.34 27.50  -0.0431 +0.0042 -0.0301
# A FAIL row carries the breach reasons after the bias columns, e.g.
#   FAIL test_0013 baseline  8.32M  9.10 ... -0.0301  mean 9.10>8.40, no-budget-entry
# so the trailing annotation is optional rather than end-of-line (#814 — the
# tool was unusable on exactly the red run a re-baseline is captured from).
ROW_RE = re.compile(
    r"^(?:PASS|FAIL)?\s*"
    r"(?P<fixture>test_\d+)\s+"
    r"(?P<case>\S+)\s+"
    r"\S+\s+"  # n_pix
    r"(?P<mean>[\d.]+)\s+"
    r"(?P<p95>[\d.]+)\s+"
    r"(?P<max>[\d.]+)\s+"
    r"(?P<bR>[+-][\d.]+)\s+"
    r"(?P<bG>[+-][\d.]+)\s+"
    r"(?P<bB>[+-][\d.]+)"
    r"(?:\s+\S.*)?\s*$"
)

def headroom(metric: str, value: float) -> float:
    """Round up + add a small floor so noise doesn't flip pass/fail."""
    if metric in ("mean", "p95", "max"):
        return max(round(value * 1.05 + 0.05, 1), 0.5 if metric == "mean" else 1.0)
    if metric == "bias":
        return max(round(abs(value) * 1.1 + 0.005, 4), 0.005)
    raise ValueError(metric)

def main() -> int:
    out: dict[str, dict[str, dict[str, float]]] = defaultdict(dict)
    for line in sys.stdin:
        m = ROW_RE.match(line)
        if not m:
            continue
        fixture = m["fixture"]
        case = m["case"]
        # Skip per-fixture aggregates which look like "(N cases)"
        if case.startswith("("):
            continue
        entry = {
            "mean": headroom("mean", float(m["mean"])),
            "p95":  headroom("p95",  float(m["p95"])),
            "max":  headroom("max",  float(m["max"])),
            "bias": max(
                headroom("bias", float(m["bR"])),
                headroom("bias", float(m["bG"])),
                headroom("bias", float(m["bB"])),
            ),
        }
        # A case can be measured by more than one diff pass against a
        # different reference resolution — test_color_pipeline.sh's neutral
        # pass uses the `down` reference and its detail pass uses `full`, and
        # a handful of sharpen_*/nr_* cases ship both. Those two rows carry
        # different numbers under one budget key, so keep the ceiling that
        # satisfies every pass rather than whichever row was read last (#814).
        prior = out[fixture].get(case)
        out[fixture][case] = entry if prior is None else {
            k: max(prior[k], entry[k]) for k in entry
        }
    print(json.dumps({"version": 1, "fixtures": dict(sorted(out.items()))}, indent=2))
    return 0

if __name__ == "__main__":
    sys.exit(main())
