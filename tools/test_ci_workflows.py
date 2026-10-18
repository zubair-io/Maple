"""Keep workflow job selection and their fail-closed result gates aligned."""

import os
import shlex
import subprocess
import tempfile
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
    def test_merge_group_allowlist_rejects_second_pr_growth(self):
        steps = workflow("cross")["jobs"]["allowlist-shrinks-only"]["steps"]
        compute = next(
            step["run"] for step in steps if step.get("name") == "Compute merge base"
        )
        compare = next(
            step["run"]
            for step in steps
            if step.get("name") == "Compare allowlist length against merge base"
        )
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)

            def git(*args):
                return subprocess.check_output(
                    ["git", *args], cwd=repo, text=True
                ).strip()

            git("init", "-q")
            git("config", "user.name", "CI Test")
            git("config", "user.email", "ci@example.invalid")
            git("config", "commit.gpgsign", "false")
            (repo / "tools").mkdir()
            (repo / "tools/check-file-budget.sh").write_text(
                'case "$path" in *.ts) : ;; esac\n'
            )
            (repo / "tools/budget-allowlist.txt").write_text("src/web/old.ts\n")
            git("add", "--", "tools/check-file-budget.sh", "tools/budget-allowlist.txt")
            git("commit", "-qm", "base")
            base = git("rev-parse", "HEAD")
            git("checkout", "-q", "-b", "first-pr")
            (repo / "first.txt").write_text("first PR\n")
            git("add", "--", "first.txt")
            git("commit", "-qm", "first PR")
            git("checkout", "-q", "-b", "second-pr", base)
            (repo / "tools/budget-allowlist.txt").write_text(
                "src/web/old.ts\nsrc/web/new.ts\n"
            )
            git("add", "--", "tools/budget-allowlist.txt")
            git("commit", "-qm", "second PR")
            git("checkout", "-q", "--detach", base)
            git("merge", "-q", "--no-ff", "first-pr", "-m", "merge first PR")
            git("merge", "-q", "--no-ff", "second-pr", "-m", "merge second PR")
            env_file = repo / "github-env"
            env = {
                **os.environ,
                "GITHUB_ENV": str(env_file),
                "GROUP_BASE": base,
                "GROUP_HEAD": git("rev-parse", "HEAD"),
            }
            computed = subprocess.run(
                [
                    "bash",
                    "-c",
                    compute.replace("${{ github.event_name }}", "merge_group"),
                ],
                cwd=repo,
                check=False,
                env=env,
                capture_output=True,
                text=True,
            )
            self.assertEqual(computed.returncode, 0, computed.stderr)
            self.assertIn(f"MERGE_BASE={base}", env_file.read_text())
            checked = subprocess.run(
                ["bash", "-c", compare],
                cwd=repo,
                check=False,
                env={**env, "MERGE_BASE": base},
                capture_output=True,
                text=True,
            )
            self.assertEqual(checked.returncode, 1, checked.stdout + checked.stderr)
            self.assertIn("src/web/new.ts", checked.stdout)

    def test_combined_group_events_and_cross_gates(self):
        names = (
            "android",
            "api",
            "apple",
            "cloudflare",
            "cross",
            "face-clustering",
            "linux",
            "maple-types",
            "publish-package",
            "raw-pipeline",
            "web",
            "windows",
        )
        for name in names:
            with self.subTest(workflow=name):
                events = workflow(name)[True]
                self.assertEqual(events["merge_group"]["types"], ["checks_requested"])
                self.assertNotIn("paths", events["merge_group"])
        selector = workflow("ci-changes")["jobs"]["select"]["steps"][-1]
        self.assertIn("tools/ci_changes.py", selector["run"])
        cross = workflow("cross")["jobs"]
        for job_id in (
            "format-check",
            "budget-headroom",
            "allowlist-shrinks-only",
            "budgets-ratchet-shrinks-only",
            "gitleaks",
        ):
            with self.subTest(job=job_id):
                job = cross[job_id]
                self.assertIn("github.event.merge_group.base_sha", str(job))
                self.assertIn("merge_group", str(job))
        self.assertIn("merge_group", cross["budget-headroom"]["if"])
        self.assertIn(
            "merge_group", cross["budgets-ratchet-shrinks-only"]["steps"][-1]["if"]
        )
        steps = {
            job_id: "\n".join(step.get("run", "") for step in cross[job_id]["steps"])
            for job_id in (
                "format-check",
                "budget-headroom",
                "allowlist-shrinks-only",
                "budgets-ratchet-shrinks-only",
                "gitleaks",
            )
        }
        self.assertIn(
            'git diff --name-only --diff-filter=ACMR "$GROUP_BASE" "$GROUP_HEAD"',
            steps["format-check"],
        )
        self.assertIn(
            'bash tools/check-budget-headroom.sh "$GROUP_BASE"',
            steps["budget-headroom"],
        )
        self.assertIn('merge_base="$GROUP_BASE"', steps["budgets-ratchet-shrinks-only"])
        self.assertIn('merge_base="$GROUP_BASE"', steps["allowlist-shrinks-only"])
        self.assertIn('RANGE="${GROUP_BASE}..${GROUP_HEAD}"', steps["gitleaks"])

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
                    elif component == "pr-or-group":
                        self.assertEqual(
                            jobs[job]["if"],
                            "github.event_name == 'pull_request' || "
                            "github.event_name == 'merge_group'",
                        )
                    else:
                        self.assertEqual(component, "always")
                        self.assertNotIn("if", jobs[job])
                for event in ("push", "pull_request", "merge_group"):
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
                            enabled = (
                                component == "always"
                                or (component == "pr" and event == "pull_request")
                                or (
                                    component == "pr-or-group"
                                    and event in ("pull_request", "merge_group")
                                )
                                or (component in CONSUMERS and selected)
                            )
                            needs[job] = {"result": "success" if enabled else "skipped"}
                        validate(needs, rules, event)

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
