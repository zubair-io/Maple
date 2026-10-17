"""Release readiness fails closed for the complete release CI suite."""

import unittest

import release_ci as ci


class ReleaseCITests(unittest.TestCase):
    def runs(self, event="pull_request"):
        return [
            {"name": name, "status": "completed", "conclusion": "success"}
            for name, events in ci.REQUIRED_WORKFLOWS.items()
            if event in events
        ]

    def test_green_release_pr_and_main(self):
        for event in ("pull_request", "push"):
            self.assertEqual(ci.waiting_for(self.runs(event), event), [])

    def test_android_missing_or_running_waits(self):
        runs = [run for run in self.runs() if run["name"] != "Android"]
        self.assertEqual(
            ci.waiting_for(runs, "pull_request"), ["Android (not started)"]
        )
        runs.append({"name": "Android", "status": "in_progress", "conclusion": None})
        self.assertEqual(
            ci.waiting_for(runs, "pull_request"), ["Android (in_progress)"]
        )

    def test_android_unsuccessful_blocks_both_gates(self):
        for event in ("pull_request", "push"):
            for conclusion in (
                "failure",
                "cancelled",
                "neutral",
                "skipped",
                "timed_out",
                None,
            ):
                runs = self.runs(event)
                next(run for run in runs if run["name"] == "Android")["conclusion"] = (
                    conclusion
                )
                with (
                    self.subTest(event=event, conclusion=conclusion),
                    self.assertRaisesRegex(ValueError, "Android"),
                ):
                    ci.waiting_for(runs, event)

    def test_no_required_workflow_can_skip_or_be_neutral(self):
        for name in ci.REQUIRED_WORKFLOWS:
            runs = self.runs()
            for conclusion in ("skipped", "neutral"):
                for run in runs:
                    if run["name"] == name:
                        run["conclusion"] = conclusion
                with (
                    self.subTest(name=name, conclusion=conclusion),
                    self.assertRaisesRegex(ValueError, name),
                ):
                    ci.waiting_for(runs, "pull_request")

    def test_path_filtered_workflows_optional_but_must_pass_when_present(self):
        for name in ("linux", "raw-pipeline"):
            for event in ("pull_request", "push"):
                runs = self.runs(event)
                optional = {
                    "name": name,
                    "status": "completed",
                    "conclusion": "success",
                }
                self.assertEqual(ci.waiting_for([*runs, optional], event), [])
                optional["status"] = "queued"
                self.assertEqual(
                    ci.waiting_for([*runs, optional], event), [f"{name} (queued)"]
                )
                optional["status"] = "completed"
                optional["conclusion"] = "failure"
                with self.assertRaisesRegex(ValueError, name):
                    ci.waiting_for([*runs, optional], event)

    def test_latest_attempt_wins(self):
        runs = self.runs()
        stale = {"name": "Android", "status": "completed", "conclusion": "failure"}
        self.assertEqual(ci.waiting_for([*runs, stale], "pull_request"), [])
        with self.assertRaisesRegex(ValueError, "Android"):
            ci.waiting_for([stale, *runs], "pull_request")

    def test_main_still_checks_extra_push_workflows_except_controller(self):
        runs = self.runs("push")
        extra = {"name": "release-handoff", "status": "in_progress"}
        self.assertEqual(ci.waiting_for([*runs, extra], "push"), [])
        extra = {
            "name": "another-check",
            "status": "completed",
            "conclusion": "failure",
        }
        with self.assertRaisesRegex(ValueError, "another-check"):
            ci.waiting_for([*runs, extra], "push")


class ReadinessWorkflowTests(unittest.TestCase):
    def test_real_workflow_shell_rejects_unsuccessful_android(self):
        import json
        import os
        import subprocess
        import tempfile
        from pathlib import Path

        root = Path(__file__).resolve().parents[1]
        workflow = (root / ".github/workflows/version-sync.yml").read_text()
        body = workflow.split("        run: |\n", 1)[1].split("\n  validate-apple:", 1)[
            0
        ]
        script = "\n".join(line[10:] for line in body.splitlines())
        with tempfile.TemporaryDirectory() as directory:
            gh = Path(directory) / "gh"
            gh.write_text('#!/bin/sh\nprintf "%s" "$MOCK_RUNS"\n')
            gh.chmod(0o755)
            for conclusion in ("failure", "neutral", "skipped", "success"):
                runs = ReleaseCITests().runs()
                next(run for run in runs if run["name"] == "Android")["conclusion"] = (
                    conclusion
                )
                env = dict(
                    os.environ,
                    PATH=directory + os.pathsep + os.environ["PATH"],
                    HEAD_BRANCH="release/next-v1.2.3",
                    HEAD_SHA="abc",
                    GITHUB_REPOSITORY="owner/repo",
                    MOCK_RUNS=json.dumps([{"workflow_runs": runs}]),
                )
                result = subprocess.run(
                    ["bash", "-c", script],
                    cwd=root,
                    check=False,
                    env=env,
                    capture_output=True,
                    text=True,
                    timeout=5,
                )
                with self.subTest(conclusion=conclusion):
                    self.assertEqual(
                        result.returncode,
                        0 if conclusion == "success" else 1,
                        result.stdout + result.stderr,
                    )
