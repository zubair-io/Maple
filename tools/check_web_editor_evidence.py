"""Require the existing 24 WB/Auto cases and both #4103 lens deployments."""

import json
import sys
from pathlib import Path


def tests_in(suite):
    for spec in suite.get("specs", []):
        yield from spec.get("tests", [])
    for child in suite.get("suites", []):
        yield from tests_in(child)


def split_reports(report):
    stats = report["stats"]
    if stats["expected"] != 26 or any(
        stats[key] != 0 for key in ("unexpected", "skipped", "flaky")
    ):
        raise ValueError("Expected 26 passing editor cases without skips/retries")
    outputs = {}
    for filename, count, output in (
        ("white-balance-workflow.spec.ts", 24, "wb-auto-tone-results.json"),
        ("lens-gesture-workflow.spec.ts", 2, "lens-gesture-results.json"),
    ):
        suites = [suite for suite in report["suites"] if suite["file"] == filename]
        tests = [test for suite in suites for test in tests_in(suite)]
        if len(tests) != count:
            raise ValueError(f"{filename}: expected exactly {count} cases")
        for test in tests:
            results = test["results"]
            if (
                test["expectedStatus"] != "passed"
                or len(results) != 1
                or results[0]["status"] != "passed"
                or results[0]["retry"] != 0
            ):
                raise ValueError(f"{filename}: a case failed, skipped or retried")
        outputs[output] = {
            **report,
            "suites": suites,
            "stats": {**stats, "expected": count},
        }
    all_tests = [test for suite in report["suites"] for test in tests_in(suite)]
    if len(all_tests) != 26 or report.get("errors"):
        raise ValueError("Unexpected editor cases or runner errors")
    return outputs


if __name__ == "__main__":
    source = Path(sys.argv[1])
    for name, report in split_reports(json.loads(source.read_text())).items():
        source.with_name(name).write_text(json.dumps(report))
    print("Verified 24 WB/Auto cases and two lens deployment cases")
