"""The workflow carries earlier queued PR budget markers into group validation."""

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from test_ci_workflows import ROOT, workflow


class GroupWorkflowTests(unittest.TestCase):
    def test_merge_group_budgets_ratchet_uses_queued_pr_bodies(self):
        job = workflow("cross")["jobs"]["budgets-ratchet-shrinks-only"]
        self.assertEqual(
            job["permissions"], {"contents": "read", "pull-requests": "read"}
        )
        step = next(
            step
            for step in job["steps"]
            if step.get("name") == "Enforce budgets.json one-way ratchet vs merge base"
        )
        self.assertIn("github.event.merge_group.head_sha", str(step["env"]))
        self.assertIn("github.token", str(step["env"]))
        script = step["run"].replace("${{ github.event_name }}", "merge_group")
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
            (repo / "tools/check_budget_ratchet.py").write_text(
                (ROOT / "tools/check_budget_ratchet.py").read_text()
            )
            (repo / "tools/ci_group_bodies.py").write_text(
                (ROOT / "tools/ci_group_bodies.py").read_text()
            )
            budgets = repo / "test-fixtures/budgets.json"
            budgets.parent.mkdir(parents=True)
            budgets.write_text(
                '{"fixtures": {"test_0000": {"baseline": '
                '{"mean": 1, "p95": 2, "max": 3, "bias": 0.1}}}}\n'
            )
            git("add", "--", "test-fixtures/budgets.json")
            git("commit", "-qm", "base")
            base = git("rev-parse", "HEAD")
            budgets.write_text(
                '{"fixtures": {"test_0000": {"baseline": '
                '{"mean": 9, "p95": 2, "max": 3, "bias": 0.1}}}}\n'
            )
            git("add", "--", "test-fixtures/budgets.json")
            git("commit", "-qm", "raise budget without a commit marker")
            bin_dir = repo / "bin"
            bin_dir.mkdir()
            gh = bin_dir / "gh"
            snapshot = {
                "data": {
                    "repository": {
                        "mergeQueue": {
                            "entries": {
                                "pageInfo": {"hasNextPage": False, "endCursor": None},
                                "nodes": [
                                    {
                                        "baseCommit": {"oid": base},
                                        "headCommit": {"oid": "a" * 40},
                                        "pullRequest": {
                                            "number": 123,
                                            "body": "RE-BASELINE: test_0000/baseline.mean: audited retune",
                                        },
                                    },
                                    {
                                        "baseCommit": {"oid": "a" * 40},
                                        "headCommit": {"oid": "b" * 40},
                                        "pullRequest": {
                                            "number": 456,
                                            "body": "no marker here",
                                        },
                                    },
                                ],
                            }
                        }
                    }
                }
            }
            gh.write_text(
                "#!/bin/sh\ncat <<'JSON'\n" + json.dumps(snapshot) + "\nJSON\n"
            )
            gh.chmod(0o755)
            env = {
                **os.environ,
                "PATH": f"{bin_dir}:{os.environ['PATH']}",
                "MERGE_BASE": base,
                "PR_BODY": "",
                "HEAD_SHA": "",
                "GH_TOKEN": "test-token",
                "GITHUB_REPOSITORY": "owner/repo",
                "GROUP_HEAD": "b" * 40,
                "GROUP_REF": "refs/heads/main",
            }
            checked = subprocess.run(
                ["bash", "-c", script],
                cwd=repo,
                check=False,
                env=env,
                capture_output=True,
                text=True,
            )
            self.assertEqual(checked.returncode, 0, checked.stdout + checked.stderr)
            self.assertIn("1 audited RE-BASELINE", checked.stdout)
            for ref in ("c" * 40, "not-a-commit"):
                with self.subTest(ref=ref):
                    blocked = subprocess.run(
                        ["bash", "-c", script],
                        cwd=repo,
                        check=False,
                        env={**env, "GROUP_HEAD": ref},
                        capture_output=True,
                        text=True,
                    )
                    self.assertNotEqual(blocked.returncode, 0)


if __name__ == "__main__":
    unittest.main()
