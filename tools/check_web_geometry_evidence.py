"""Require both real-sidecar geometry deployment cases for #4121."""
import json
import sys
from pathlib import Path


def validate(report):
    expected = {
        f"{deployment}: geometry gestures preserve photo ownership, immediate edits and Undo"
        for deployment in ("Hosted", "Self Hosted")
    }
    stats = report["stats"]
    if (
        stats["expected"] != 2
        or any(stats[key] != 0 for key in ("unexpected", "skipped", "flaky"))
        or report.get("errors")
    ):
        raise ValueError("Expected exactly two passing geometry cases without errors/skips/retries")

    def specs_in(suite):
        yield from suite.get("specs", [])
        for child in suite.get("suites", []):
            yield from specs_in(child)

    suites = report["suites"]
    if any(suite["file"] != "geometry-gesture-workflow.spec.ts" for suite in suites):
        raise ValueError("Unexpected geometry evidence file")
    specs = [spec for suite in suites for spec in specs_in(suite)]
    if len(specs) != 2 or {spec["title"] for spec in specs} != expected:
        raise ValueError("Missing, duplicate or unexpected geometry deployment")
    for spec in specs:
        tests = spec["tests"]
        if len(tests) != 1 or tests[0]["expectedStatus"] != "passed":
            raise ValueError("Geometry deployment must execute once and expect success")
        results = tests[0]["results"]
        if (
            len(results) != 1
            or results[0]["status"] != "passed"
            or results[0]["retry"] != 0
        ):
            raise ValueError("Geometry deployment failed, skipped or retried")
    return 2


if __name__ == "__main__":
    count = validate(json.loads(Path(sys.argv[1]).read_text()))
    print(f"Verified {count} geometry deployment cases")
