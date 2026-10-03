"""Require exact browser (#4107) and HTTP/IndexedDB/native (#4111) retry evidence."""

import json
import sys
from pathlib import Path


def specs_in(suite):
    yield from suite.get("specs", [])
    for child in suite.get("suites", []):
        yield from specs_in(child)


def scenario_titles(self_hosted=False):
    if self_hosted:
        return {
            "Self Hosted retry retains original identities through HTTP/IndexedDB "
            + scenario
            for scenario in (
                "acknowledged repeated retry",
                "lost acknowledgement and reload",
            )
        }
    return {
        f"browser export retry protects original identities: {scenario}"
        for scenario in ("new", "legacy", "legacy-filtered", "missing", "unrelated")
    }


def validate(report, self_hosted=False):
    expected = scenario_titles(self_hosted)
    count = len(expected)
    stats = report["stats"]
    if (
        stats["expected"] != count
        or any(stats[key] != 0 for key in ("unexpected", "skipped", "flaky"))
        or report.get("errors")
    ):
        raise ValueError(
            f"Expected exactly {count} passing cases without errors/skips/retries"
        )
    specs = [spec for suite in report["suites"] for spec in specs_in(suite)]
    if len(specs) != count or {spec["title"] for spec in specs} != expected:
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
    return count


if __name__ == "__main__":
    self_hosted = len(sys.argv) > 2 and sys.argv[2] == "self-hosted"
    count = validate(json.loads(Path(sys.argv[1]).read_text()), self_hosted=self_hosted)
    print(f"Verified {count} export original-protection cases")
