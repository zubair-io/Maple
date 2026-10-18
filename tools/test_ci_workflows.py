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
from release_ci import PATH_FILTERED_WORKFLOWS, REQUIRED_WORKFLOWS

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

            git("init", "-q", "-b", "main")
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
            git("remote", "add", "origin", ".")
            git("checkout", "-q", "-b", "first-pr")
            (repo / "tools/budget-allowlist.txt").write_text(
                "src/web/old.ts\nsrc/web/new.ts\n"
            )
            git("add", "--", "tools/budget-allowlist.txt")
            git("commit", "-qm", "first PR")
            git("checkout", "-q", "-b", "second-pr", base)
            (repo / "docs.md").write_text("second PR\n")
            git("add", "--", "docs.md")
            git("commit", "-qm", "second PR")
            git("checkout", "-q", "--detach", base)
            git("merge", "-q", "--no-ff", "first-pr", "-m", "merge first PR")
            prior_group_head = git("rev-parse", "HEAD")
            git("merge", "-q", "--no-ff", "second-pr", "-m", "merge second PR")
            env_file = repo / "github-env"
            env = {
                **os.environ,
                "GITHUB_ENV": str(env_file),
                "GROUP_BASE": prior_group_head,
                "GROUP_HEAD": git("rev-parse", "HEAD"),
                "GROUP_REF": "refs/heads/main",
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
            invalid = (
                {"GROUP_REF": "refs/heads/../main"},
                {"GROUP_REF": "main"},
                {"GROUP_BASE": "HEAD"},
                {"GROUP_HEAD": prior_group_head},
            )
            for override in invalid:
                with self.subTest(override=override):
                    malformed = subprocess.run(
                        ["bash", "-c", compute.replace("${{ github.event_name }}", "merge_group")],
                        cwd=repo,
                        check=False,
                        env={**env, **override},
                        capture_output=True,
                        text=True,
                    )
                    self.assertNotEqual(malformed.returncode, 0)
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
            'git diff --name-only --diff-filter=ACMR "$target_base" "$GROUP_HEAD"',
            steps["format-check"],
        )
        self.assertIn(
            'bash tools/check-budget-headroom.sh "$(git merge-base FETCH_HEAD "$GROUP_HEAD")"',
            steps["budget-headroom"],
        )
        for script in steps.values():
            self.assertIn('git fetch --no-tags origin "$GROUP_REF"', script)
            self.assertIn('"$GROUP_REF" = refs/heads/* ]] || exit 1', script)
        self.assertIn(
            'merge_base="$(git merge-base FETCH_HEAD "$GROUP_HEAD")"',
            steps["budgets-ratchet-shrinks-only"],
        )
        self.assertIn(
            'merge_base="$(git merge-base FETCH_HEAD "$GROUP_HEAD")"',
            steps["allowlist-shrinks-only"],
        )
        self.assertIn(
            'RANGE="$(git merge-base FETCH_HEAD "$GROUP_HEAD")..${GROUP_HEAD}"',
            steps["gitleaks"],
        )

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

    def test_release_readiness_finds_every_workflow_by_its_run_name(self):
        names = {
            yaml.safe_load(path.read_text()).get("name", str(path.relative_to(ROOT)))
            for path in WORKFLOWS.glob("*.yml")
        }
        for required in {*REQUIRED_WORKFLOWS, *PATH_FILTERED_WORKFLOWS}:
            with self.subTest(required=required):
                self.assertIn(required, names)


if __name__ == "__main__":
    unittest.main()
