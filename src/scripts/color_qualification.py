#!/usr/bin/env python3
"""Count actual comparisons and unique budget cases without discarding resolutions (#4226)."""

import json
import sys
from collections import Counter, defaultdict

STATUSES = {
    "passed": "compared",
    "failed": "compared",
    "error": "errors",
    "missing_raw": "skipped_no_raw",
    "missing_candidate": "skipped_no_candidate",
    "missing_reference": "skipped_no_reference",
}
PASSES = ("neutral", "auto", "detail-fullres")


def detail_case(name):
    return name.split("/", 1)[-1].startswith(("sharpen", "nr_"))


def expected_attempts(manifest, resolution, name_filter):
    plans = {name: {} for name in PASSES}
    for case in manifest["cases"]:
        name = case["name"]
        if name_filter and name_filter not in name:
            continue
        if len(name.split("/")) != 2 or not all(name.split("/")):
            raise ValueError(f"invalid fixture/case identity: {name}")
        outputs = [output["resolution"] for output in case["outputs"]]
        if len(outputs) != len(set(outputs)):
            raise ValueError(f"duplicate output resolution: {name}")
        # Only a structurally full-only detail case may omit the down check.
        required = not (
            resolution not in outputs and detail_case(name) and "full" in outputs
        )
        if name in plans["neutral"]:
            raise ValueError(f"duplicate manifest identity: {name}")
        plans["neutral"][name] = required
        if name.endswith("/baseline"):
            plans["auto"][name + "_auto"] = True
        if detail_case(name):
            plans["detail-fullres"][name] = True
    return plans


def aggregate(summaries, manifest, resolution="down", name_filter=""):
    plans = expected_attempts(manifest, resolution, name_filter)
    seen_passes = set()
    outcomes = defaultdict(list)
    comparisons = Counter()
    for summary in summaries:
        name = summary.get("profile", "neutral")
        if name not in plans or name in seen_passes:
            raise ValueError(f"unexpected or duplicate pass: {name}")
        seen_passes.add(name)
        observed = {}
        counts = Counter()
        for identity, status in summary["observations"]:
            if (
                identity in observed
                or identity not in plans[name]
                or status not in STATUSES
            ):
                raise ValueError(
                    f"invalid/duplicate observation: {name}/{identity}/{status}"
                )
            observed[identity] = status
            counts[STATUSES[status]] += 1
            counts["breaches"] += status == "failed"
            required = plans[name][identity]
            if not required and status not in (
                "missing_reference",
                "missing_raw",
                "missing_candidate",
            ):
                raise ValueError(
                    f"unexpected comparison without declared resolution: {identity}"
                )
            if required:
                profile = "auto" if name == "auto" else "neutral"
                outcomes[(profile, identity)].append(status)
        if set(observed) != set(plans[name]):
            raise ValueError(
                f"missing observations in {name}: {set(plans[name]) - set(observed)}"
            )
        for field in (*set(STATUSES.values()), "breaches"):
            if summary[field] != counts[field]:
                raise ValueError(
                    f"inconsistent {name}/{field}: {summary[field]} != {counts[field]}"
                )
        comparisons.update(counts)
    if seen_passes != set(PASSES):
        raise ValueError(f"missing passes: {set(PASSES) - seen_passes}")
    executed = sum(
        any(s in ("passed", "failed") for s in states) for states in outcomes.values()
    )
    failed = sum(
        any(s in ("failed", "error") for s in states) for states in outcomes.values()
    )
    skipped = sum(
        any(s.startswith("missing_") for s in states) for states in outcomes.values()
    )
    return {
        "executed": executed,
        "failed": failed,
        "skipped": skipped,
        "expected": len(outcomes),
        "comparisons": comparisons["compared"],
        "comparison_failures": comparisons["breaches"] + comparisons["errors"],
    }


def main():
    with open(sys.argv[1]) as source:
        summaries = [json.loads(line) for line in source if line.strip()]
    with open(sys.argv[2]) as source:
        manifest = json.load(source)
    result = aggregate(summaries, manifest, sys.argv[3], sys.argv[4])
    print(
        f"comparisons: executed={result['comparisons']} failed={result['comparison_failures']}"
    )
    print(
        f"qualification: executed={result['executed']} failed={result['failed']} "
        f"skipped={result['skipped']}"
    )
    return int(result["failed"] > 0 or result["skipped"] > 0 or result["executed"] == 0)


if __name__ == "__main__":
    sys.exit(main())
