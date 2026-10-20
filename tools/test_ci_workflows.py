"""Keep workflow job selection and their fail-closed result gates aligned."""

import shlex
import unittest
from pathlib import Path

import yaml
from ci_changes import CONSUMERS
from ci_result import validate

ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = ROOT / ".github/workflows"


def workflow(name):
    return yaml.safe_load((WORKFLOWS / f"{name}.yml").read_text())


class WorkflowTests(unittest.TestCase):
    def test_raw_pipeline_watches_its_comparison_regressions(self):
        events = workflow("raw-pipeline")[True]
        for event in ("push", "pull_request"):
            for path in (
                "src/scripts/color_pipeline_test.py",
                "src/scripts/compare_images_metadata_test.py",
            ):
                with self.subTest(event=event, path=path):
                    self.assertIn(path, events[event]["paths"])

    def test_windows_architectures_are_native_and_release_artifacts_do_not_collide(
        self,
    ):
        expected = {
            "x64": ("windows-latest", "x86_64-pc-windows-msvc"),
            "arm64": ("windows-11-arm", "aarch64-pc-windows-msvc"),
        }
        for name, job_id in (
            ("windows", "windows-build-and-test"),
            ("release", "windows-build"),
        ):
            job = workflow(name)["jobs"][job_id]
            self.assertEqual(job["runs-on"], "${{ matrix.runner }}")
            self.assertFalse(job["strategy"]["fail-fast"])
            rows = job["strategy"]["matrix"]["include"]
            self.assertEqual(
                {row["arch"].lower(): (row["runner"], row["target"]) for row in rows},
                expected,
            )
            uploads = [
                step
                for step in job["steps"]
                if step.get("uses", "").startswith("actions/upload-artifact@")
            ]
            for step in uploads:
                self.assertIn("${{ matrix.arch }}", step["with"]["name"])
            verifier = next(
                step
                for step in job["steps"]
                if "verify-native-architecture.ps1" in step.get("run", "")
            )
            self.assertIn("${{ matrix.arch }}", verifier["run"])

    def test_windows_release_signs_both_native_payloads_on_x64(self):
        jobs = workflow("release")["jobs"]
        build = jobs["windows-build"]
        sign = jobs["windows-app"]
        self.assertEqual(sign["runs-on"], "windows-latest")
        self.assertEqual(sign["needs"], ["windows-build"])
        self.assertEqual(set(sign["strategy"]["matrix"]["arch"]), {"x64", "arm64"})
        uploads = [
            s
            for s in build["steps"]
            if s.get("uses", "").startswith("actions/upload-artifact@")
        ]
        downloads = [
            s
            for s in sign["steps"]
            if s.get("uses", "").startswith("actions/download-artifact@")
        ]
        self.assertEqual(uploads[0]["with"]["name"], downloads[0]["with"]["name"])
        self.assertEqual(downloads[0]["with"]["path"], "publish")
        for job_id, job in jobs.items():
            for step in job["steps"]:
                if step.get("uses", "").startswith("azure/trusted-signing-action@"):
                    self.assertEqual(job_id, "windows-app")
        self.assertEqual(jobs["publish-release"]["needs"], ["windows-app"])

    def test_selection_outputs_reach_callers(self):
        config = workflow("ci-changes")
        # PyYAML's YAML 1.1 loader interprets the unquoted Actions 'on' as True.
        public = config[True]["workflow_call"]["outputs"]
        internal = config["jobs"]["select"]["outputs"]
        self.assertEqual(set(public), set(CONSUMERS))
        self.assertEqual(set(internal), set(CONSUMERS))
        for component in CONSUMERS:
            self.assertIn(
                f"jobs.select.outputs.{component}", public[component]["value"]
            )
            self.assertIn(f"steps.changes.outputs.{component}", internal[component])

    def test_workflow_gates_cover_every_job_and_selection(self):
        for name in ("android", "api", "windows", "web", "maple-types", "cross"):
            with self.subTest(workflow=name):
                jobs = workflow(name)["jobs"]
                self.assertEqual(
                    jobs["changes"]["uses"], "./.github/workflows/ci-changes.yml"
                )
                gate = jobs["result"]
                self.assertEqual(gate["if"], "always()")
                self.assertEqual(set(gate["needs"]), set(jobs) - {"result"})
                step = next(step for step in gate["steps"] if "run" in step)
                self.assertEqual(step["env"]["NEEDS_JSON"], "${{ toJSON(needs) }}")
                command = shlex.split(step["run"])
                self.assertEqual(command[:2], ["python3", "tools/ci_result.py"])
                rules = dict(item.split("=", 1) for item in command[2:])
                self.assertEqual(set(rules), set(jobs) - {"changes", "result"})
                for job, component in rules.items():
                    if component in CONSUMERS:
                        needs = jobs[job]["needs"]
                        self.assertIn(
                            "changes", [needs] if isinstance(needs, str) else needs
                        )
                        self.assertEqual(
                            jobs[job]["if"],
                            f"needs.changes.outputs.{component} == 'true'",
                        )
                    elif component == "pr":
                        self.assertEqual(
                            jobs[job]["if"], "github.event_name == 'pull_request'"
                        )
                    else:
                        self.assertEqual(component, "always")
                        self.assertNotIn("if", jobs[job])
                for event in ("push", "pull_request"):
                    for selected in (True, False):
                        needs = {
                            "changes": {
                                "result": "success",
                                "outputs": {
                                    component: str(selected).lower()
                                    for component in CONSUMERS
                                },
                            }
                        }
                        for job, component in rules.items():
                            enabled = component == "always" or (
                                event == "pull_request"
                                if component == "pr"
                                else selected
                            )
                            needs[job] = {"result": "success" if enabled else "skipped"}
                        validate(needs, rules, event)

    def test_apple_swift_jobs_are_selected_and_gated_fail_closed(self):
        config = workflow("apple")
        jobs = config["jobs"]
        self.assertEqual(jobs["changes"]["uses"], "./.github/workflows/ci-changes.yml")
        for event in ("push", "pull_request"):
            self.assertNotIn("paths", config[True][event] or {})
        selected = {
            "swift-build",
            "swift-ui",
            "swift-regressions",
            "swift-regressions-coverage",
        }
        for job in selected:
            with self.subTest(job=job):
                self.assertEqual(jobs[job]["needs"], "changes")
                self.assertEqual(
                    jobs[job]["if"], "needs.changes.outputs.swift == 'true'"
                )
        gate = jobs["validation-result"]
        self.assertEqual(gate["if"], "always()")
        self.assertEqual(set(gate["needs"]), set(jobs) - {"validation-result"})
        step = next(step for step in gate["steps"] if "run" in step)
        self.assertEqual(step["env"]["NEEDS_JSON"], "${{ toJSON(needs) }}")
        command = shlex.split(step["run"])
        self.assertEqual(command[:2], ["python3", "tools/ci_result.py"])
        rules = dict(item.split("=", 1) for item in command[2:])
        self.assertEqual(
            rules,
            {
                "swift-build": "swift",
                "swift-ui": "swift",
                "swift-regressions": "swift",
                "swift-regressions-coverage": "swift",
            },
        )
        self.assertEqual(
            config[True]["workflow_call"]["outputs"]["validated_sha"]["value"],
            "${{ jobs.validation-result.outputs.sha }}",
        )

    def test_apple_result_gate_passes_skips_and_rejects_missing_runs(self):
        rules = {
            "swift-build": "swift",
            "swift-ui": "swift",
            "swift-regressions": "swift",
            "swift-regressions-coverage": "swift",
        }

        def needs(swift, result):
            return {
                "changes": {"result": "success", "outputs": {"swift": swift}},
                **{job: {"result": result} for job in rules},
            }

        validate(needs("false", "skipped"), rules, "pull_request")
        validate(needs("true", "success"), rules, "pull_request")
        with self.assertRaises(ValueError):
            validate(needs("true", "skipped"), rules, "pull_request")
        with self.assertRaises(ValueError):
            validate(needs("true", "failure"), rules, "pull_request")
        with self.assertRaises(ValueError):
            validate(needs("false", "success"), rules, "pull_request")

    def test_readiness_uses_a_runner_only_for_release_prs_and_merge_groups(self):
        job = workflow("version-sync")["jobs"]["release-readiness"]
        self.assertEqual(job["name"], "Release readiness")
        self.assertEqual(
            job["if"],
            "(github.event_name == 'pull_request' && startsWith(github.head_ref, 'release/next-v')) || github.event_name == 'merge_group'",
        )

    def test_merge_group_handoff_runs_do_not_share_the_serialized_queue(self):
        config = workflow("release-handoff")
        group = config["concurrency"]["group"]
        self.assertIn("github.event.merge_group.head_sha", group)
        self.assertIn("'release-handoff'", group)
        self.assertFalse(config["concurrency"]["cancel-in-progress"])
        release = workflow("version-sync")["jobs"]["create-release"]
        self.assertEqual(release["concurrency"]["group"], "release-handoff")
        self.assertFalse(release["concurrency"]["cancel-in-progress"])

    def test_aggregate_checks_have_unique_stable_names(self):
        names = [
            workflow(name)["jobs"]["result"]["name"]
            for name in ("android", "api", "windows", "web", "maple-types", "cross")
        ]
        names.append(workflow("apple")["jobs"]["validation-result"]["name"])
        self.assertEqual(
            set(names),
            {
                "Android result",
                "API result",
                "Windows result",
                "Web result",
                "Maple types result",
                "Cross result",
                "Apple result",
            },
        )

    def test_release_names_and_native_trigger_coverage(self):
        for name in ("android", "api", "windows", "web", "maple-types", "cross"):
            self.assertIn("pull_request", workflow(name)[True])
            self.assertIsNone(workflow(name)[True]["pull_request"])
        paths = workflow("publish-package")[True]["pull_request"]["paths"]
        self.assertIn("src/raw-pipeline/**", paths)
        self.assertIn("src/maple/**", paths)
        self.assertIn("src/apple/MapleUITests/Goldens/.calibration/**", paths)
        for event in ("push", "pull_request"):
            self.assertIn(
                ".github/workflows/cloudflare.yml",
                workflow("cloudflare")[True][event]["paths"],
            )


if __name__ == "__main__":
    unittest.main()
