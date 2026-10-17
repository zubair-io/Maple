"""Run the release asset wait step with disposable GitHub CLI responses."""

import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]


class ReleaseAssetsTests(unittest.TestCase):
    def run_wait(self, tag="v1.2.3", conclusion="success", rounds=1):
        workflow = yaml.safe_load((ROOT / ".github/workflows/release.yml").read_text())
        step = next(
            step
            for step in workflow["jobs"]["publish-release"]["steps"]
            if step.get("name", "").startswith("Wait for")
        )
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            # Execute the actual workflow shell. Nothing can reach the real gh.
            gh = folder / "gh"
            gh.write_text("""#!/usr/bin/env python3
import json, os, pathlib, subprocess, sys
args = sys.argv[1:]
root = pathlib.Path(os.environ["FAKE_ROOT"])
with (root / "calls").open("a") as calls:
    calls.write(json.dumps(args) + "\\n")
assert args[0:2] in (["release", "view"], ["run", "list"]), args
assert args[args.index("--repo") + 1] == "example/maple", args
if args[:2] == ["run", "list"]:
    for flag, value in (("--workflow", "android-distribution.yml"),
                        ("--commit", "test-sha"), ("--branch", os.environ["GITHUB_REF_NAME"]),
                        ("--event", "push")):
        assert args[args.index(flag) + 1] == value, args
    tag = os.environ["GITHUB_REF_NAME"]
    # GitHub applies these filters before --limit. Earlier unrelated failures
    # must not shadow the release tag's run, even on the same commit.
    data = [
        {"headBranch": "main", "headSha": "test-sha", "event": "push", "conclusion": "failure"},
        {"headBranch": tag, "headSha": "old-sha", "event": "push", "conclusion": "failure"},
        {"headBranch": tag, "headSha": "test-sha", "event": "workflow_dispatch", "conclusion": "failure"},
    ]
    if os.environ["FAKE_CONCLUSION"] != "missing":
        data += [{"headBranch": tag, "headSha": "test-sha", "event": "push", "conclusion": os.environ["FAKE_CONCLUSION"]}]
    for flag, field in (("--commit", "headSha"), ("--branch", "headBranch"), ("--event", "event")):
        data = [run for run in data if run[field] == args[args.index(flag) + 1]]
    data = data[:int(args[args.index("--limit") + 1])]
else:
    count = root / "rounds"
    current = int(count.read_text()) + 1 if count.exists() else 1
    count.write_text(str(current))
    version = os.environ["GITHUB_REF_NAME"][1:]
    names = [f"Maple-macOS-{version}.dmg"]
    if "-" not in version:
        names += [f"Maple-Android-{version}.apk", f"Maple-Android-{version}.aab",
                  "Maple-Android-SHA256SUMS.txt", "Maple-Android-upload-certificate.pem"]
    data = {"assets": [{"name": name} for name in names]} if current >= int(os.environ["FAKE_ROUNDS"]) else {"assets": []}
result = subprocess.run(["/usr/bin/jq", "-r", args[args.index("--jq") + 1]],
                        input=json.dumps(data), text=True, capture_output=True)
sys.stdout.write(result.stdout)
sys.stderr.write(result.stderr)
sys.exit(result.returncode)
""")
            gh.chmod(0o755)
            sleep = folder / "sleep"
            sleep.write_text('#!/bin/sh\necho sleep >> "$FAKE_ROOT/calls"\n')
            sleep.chmod(0o755)
            result = subprocess.run(
                ["bash", "-e", "-c", step["run"]],
                check=False,
                cwd=ROOT,
                env=os.environ
                | {
                    "PATH": f"{folder}:{os.environ['PATH']}",
                    "FAKE_ROOT": directory,
                    "FAKE_CONCLUSION": conclusion,
                    "FAKE_ROUNDS": str(rounds),
                    "GITHUB_REF_NAME": tag,
                    "GITHUB_SHA": "test-sha",
                    "REPOSITORY": "example/maple",
                },
                capture_output=True,
                text=True,
                timeout=3,
            )
            calls = (folder / "calls").read_text()
            return result, calls

    def test_prerelease_finishes_with_mac_only_and_no_android_query(self):
        result, calls = self.run_wait("v1.2.3-rc.1")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn('"run", "list"', calls)
        self.assertNotIn("sleep", calls)

    def test_android_failure_or_cancellation_fails_before_sleep(self):
        for conclusion in (
            "failure",
            "cancelled",
            "timed_out",
            "action_required",
            "skipped",
            "neutral",
        ):
            with self.subTest(conclusion=conclusion):
                result, calls = self.run_wait(conclusion=conclusion, rounds=2)
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                self.assertIn(conclusion, result.stdout + result.stderr)
                self.assertNotIn("sleep", calls)

    def test_running_missing_or_successful_run_waits_for_all_stable_assets(self):
        for conclusion in ("missing", "", "success"):
            with self.subTest(conclusion=conclusion):
                result, calls = self.run_wait(conclusion=conclusion, rounds=2)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertEqual(calls.count("sleep"), 1)
                self.assertIn('"run", "list"', calls)

    def test_push_job_condition_skips_prerelease_before_signing(self):
        workflow = yaml.safe_load(
            (ROOT / ".github/workflows/android-distribution.yml").read_text()
        )
        condition = workflow["jobs"]["signed-build"]["if"]
        for tag, expected in (("v1.2.3", True), ("v1.2.3-rc.1", False)):
            with self.subTest(tag=tag):
                values = {
                    "github.event_name": "push",
                    "github.ref_type": "tag",
                    "github.ref_name": tag,
                    "github.ref": f"refs/tags/{tag}",
                    "github.repository": "example/maple",
                }
                expression = re.sub(
                    r"github\.[a-zA-Z_.]+",
                    lambda match, values=values: repr(values.get(match[0], "")),
                    condition,
                )
                expression = expression.replace("&&", " and ").replace("||", " or ")
                expression = re.sub(r"!(?!=)", " not ", expression)
                actual = eval(
                    " ".join(expression.split()),
                    {"__builtins__": {}, "contains": lambda a, b: b in a},
                )
                self.assertEqual(actual, expected)


if __name__ == "__main__":
    unittest.main()
