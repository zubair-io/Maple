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
            s for s in build["steps"] if s.get("uses") == "actions/upload-artifact@v4"
        ]
        downloads = [
            s for s in sign["steps"] if s.get("uses") == "actions/download-artifact@v4"
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
        for name in ("api", "windows", "web", "maple-types", "cross"):
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

    def test_release_names_and_native_trigger_coverage(self):
        for name in ("api", "windows", "web", "maple-types", "cross"):
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
