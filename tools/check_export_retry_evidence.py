"""Require all five actual-service browser original-protection cases for #4107."""

import json
import sys
from pathlib import Path


def specs_in(suite):
    yield from suite.get("specs", [])
    for child in suite.get("suites", []):
        yield from specs_in(child)


def validate(report):
    stats = report["stats"]
    if (
        stats["expected"] != 5
        or any(stats[key] != 0 for key in ("unexpected", "skipped", "flaky"))
        or report.get("errors")
    ):
        raise ValueError(
            "Expected exactly five passing cases without errors/skips/retries"
        )
    expected = {
        f"browser export retry protects original identities: {scenario}"
        for scenario in ("new", "legacy", "legacy-filtered", "missing", "unrelated")
    }
    specs = [spec for suite in report["suites"] for spec in specs_in(suite)]
    if len(specs) != 5 or {spec["title"] for spec in specs} != expected:
        raise ValueError(
            "Missing, duplicate or unexpected original-protection scenario"
        )
    for spec in specs:
        tests = spec["tests"]
        if len(tests) != 1:
            raise ValueError("A scenario must execute exactly once")
        results = tests[0]["results"]
        if (
            len(results) != 1
            or results[0]["status"] != "passed"
            or results[0]["retry"] != 0
        ):
            raise ValueError("A scenario failed, skipped or retried")
    return 5


if __name__ == "__main__":
    print(
        f"Verified {validate(json.loads(Path(sys.argv[1]).read_text()))} export original-protection cases"
    )
