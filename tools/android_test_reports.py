"""Reject missing, truncated or skipped Android coverage, even after Gradle passes."""

import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "src/android/app/build"


def verify(directory, minimum):
    reports = sorted(directory.rglob("TEST-*.xml"))
    if not reports:
        raise ValueError(f"Missing Android test reports: {directory}")
    cases = [case for report in reports for case in ET.parse(report).iter("testcase")]
    if len(cases) < minimum:
        raise ValueError(
            f"Expected at least {minimum} tests, got {len(cases)}: {directory}"
        )
    for case in cases:
        if any(
            case.find(status) is not None for status in ("skipped", "failure", "error")
        ):
            raise ValueError(f"Test did not pass: {case.attrib}")
    print(f"{directory}: {len(cases)} passed, no skips")


if __name__ == "__main__":
    verify(ROOT / "outputs/androidTest-results/connected", 37)
    verify(ROOT / "test-results/testDebugUnitTest", 26)
