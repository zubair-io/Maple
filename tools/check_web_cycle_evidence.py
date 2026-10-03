"""Reject missing, partial, skipped or retried #4090 browser cycle evidence."""

import base64
import json
import sys
from pathlib import Path


def tests_in(suite):
    for spec in suite.get("specs", []):
        yield from spec.get("tests", [])
    for child in suite.get("suites", []):
        yield from tests_in(child)


def validate(report):
    stats = report["stats"]
    if stats["expected"] != 2 or any(
        stats[key] != 0 for key in ("unexpected", "skipped", "flaky")
    ):
        raise ValueError(
            f"Expected exactly two passing tests without retries/skips: {stats}"
        )
    tests = [test for suite in report["suites"] for test in tests_in(suite)]
    if len(tests) != 2:
        raise ValueError("Expected exactly two deployment tests")
    deployments = set()
    for test in tests:
        results = test["results"]
        if (
            len(results) != 1
            or results[0]["status"] != "passed"
            or results[0]["retry"] != 0
        ):
            raise ValueError("A deployment failed, skipped or retried")
        attachments = [
            item
            for item in results[0]["attachments"]
            if item["name"] == "repeated-workflow-cycles"
        ]
        if len(attachments) != 1:
            raise ValueError("Missing or duplicate deployment cycle evidence")
        attachment = attachments[0]
        if attachment.get("contentType") != "application/json":
            raise ValueError("Cycle evidence must be JSON")
        evidence = json.loads(base64.b64decode(attachment["body"], validate=True))
        deployment = evidence["deployment"]
        if deployment not in ("Hosted", "Self Hosted") or deployment in deployments:
            raise ValueError("Missing, unexpected or duplicate deployment")
        deployments.add(deployment)
        cycles = evidence["cycles"]
        if (
            evidence["completed"] != 100
            or evidence["expected"] != 100
            or len(cycles) != 100
        ):
            raise ValueError("A deployment did not execute exactly 100 cycles")
        if [row["cycle"] for row in cycles] != list(range(1, 101)):
            raise ValueError("Cycle evidence is missing, duplicated or out of order")
        limit = evidence["historyLimit"]
        if not isinstance(limit, int) or limit <= 0:
            raise ValueError("Missing generated history limit")
        for row in cycles:
            cycle = row["cycle"]
            tool = "exposure" if cycle % 2 else "contrast"
            value = (
                (0.75 if cycle % 4 == 1 else -0.5)
                if cycle % 2
                else (12 if cycle % 4 == 2 else -8)
            )
            if row["tool"] != tool or row["value"] != value:
                raise ValueError("Missing representative visible edit")
            if row["historyCount"] != min(cycle * 3, limit):
                raise ValueError("Durable history compaction evidence drifted")
    return 200


if __name__ == "__main__":
    print(
        f"Verified {validate(json.loads(Path(sys.argv[1]).read_text()))} actual browser cycles"
    )
