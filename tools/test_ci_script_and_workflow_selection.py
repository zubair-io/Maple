"""Workflow-file and src/scripts selection: the Mac jobs run only what reaches them."""

import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import ci_changes as ci

SCRIPT = Path(ci.__file__).resolve()


class WorkflowAndScriptSelectionTests(unittest.TestCase):
    def test_workflow_edits_select_the_jobs_the_workflow_defines(self):
        root = SCRIPT.parent.parent
        gate = re.compile(r"needs\.changes\.outputs\.(\w+)")
        # Shared or release-path files: an edit can change any consumer's jobs.
        keep_default = {
            "ci-changes.yml",
            "publish-package.yml",
            "release-handoff.yml",
            "release.yml",
            "version-sync.yml",
        }
        callers = {
            name: re.findall(
                r"uses: \./\.github/workflows/([\w-]+\.yml)",
                (root / ".github/workflows" / name).read_text(),
            )
            for name in sorted(
                file.name for file in (root / ".github/workflows").glob("*.yml")
            )
        }
        for name, called in callers.items():
            path = f".github/workflows/{name}"
            text = (root / path).read_text()
            gated = set(gate.findall(text))
            with self.subTest(workflow=name):
                if name in keep_default:
                    self.assertNotIn(path, ci.WORKFLOW_CONSUMERS)
                    continue
                # A workflow another one calls runs inside that caller's jobs.
                self.assertEqual(
                    [
                        other
                        for other, uses in callers.items()
                        if name in uses and other not in keep_default
                    ],
                    [],
                )
                # A release workflow that calls it validates the release with it.
                release = (
                    {"release"}
                    if any(name in uses for other, uses in callers.items() if other in keep_default)
                    else set()
                )
                self.assertEqual(ci.WORKFLOW_CONSUMERS[path], gated | {"ci"} | release)

    def test_scripts_the_mac_jobs_reach_keep_every_consumer(self):
        root = SCRIPT.parent.parent
        reached, complete = ci.swift_script_closure()
        self.assertTrue(complete)
        listing = subprocess.check_output(
            ["git", "ls-files", "-z", "--", "src/apple", ".github/workflows/apple.yml"],
            cwd=root,
        )
        text = "".join(
            (root / name).read_text(encoding="utf-8", errors="ignore")
            for name in os.fsdecode(listing).split("\0")[:-1]
            if (root / name).is_file()
        )
        scripts = subprocess.check_output(
            ["git", "ls-files", "-z", "--", "src/scripts"], cwd=root
        )
        # Independent of the selector's own search: every script whose name
        # appears anywhere in the Mac jobs' trees.
        named = {
            name
            for name in os.fsdecode(scripts).split("\0")[:-1]
            if not name.endswith(".md") and name.rsplit("/", 1)[-1] in text
        }
        self.assertGreaterEqual(len(named), 5)
        self.assertLessEqual(named, reached)
        for path in (
            "src/scripts/derive_agx_lut.py",
            "src/scripts/test_color_pipeline.sh",
            "src/scripts/test_export_recipe_interchange.sh",
            "src/scripts/_agx_emit.py",
            # Named only by test_color_pipeline.sh.
            "src/scripts/banding_check.py",
        ):
            with self.subTest(path=path):
                self.assertIn(path, reached)
                self.assertEqual(ci.dependencies(path), ci.ALL)

    def test_scripts_no_mac_job_reaches_skip_only_the_mac_jobs(self):
        everything_but_mac = ci.ALL - {"swift"}
        for path in (
            # Run by face-clustering.yml alone.
            "src/scripts/test_face_clustering.sh",
            "src/scripts/halo_check.py",
            "src/scripts/pano_metrics.py",
            "src/scripts/acr-reference/test_reference_settings.py",
            "src/scripts/acr-reference/README.md",
        ):
            with self.subTest(path=path):
                self.assertEqual(ci.dependencies(path), everything_but_mac)

    def test_deleted_or_renamed_scripts_keep_the_mac_jobs(self):
        # halo_check.py is outside the closure; a script that is gone from the
        # tree must still select the Mac jobs, since one may call it.
        path = "src/scripts/halo_check.py"
        self.assertNotIn("swift", ci.dependencies(path))
        with tempfile.TemporaryDirectory() as empty, patch.object(ci, "ROOT", Path(empty)):
            self.assertEqual(ci.dependencies(path), ci.ALL)

    def test_renamed_reader_trees_make_the_search_incomplete(self):
        with tempfile.TemporaryDirectory() as empty:
            subprocess.run(["git", "init", "-q", empty], check=True)
            self.assertEqual(
                ci.swift_script_closure.__wrapped__(Path(empty)), (frozenset(), False)
            )

    def test_scripts_stay_on_every_consumer_when_the_search_fails(self):
        failed = (frozenset(), False)
        with patch.object(ci, "swift_script_closure", return_value=failed):
            self.assertEqual(ci.dependencies("src/scripts/halo_check.py"), ci.ALL)


if __name__ == "__main__":
    unittest.main()
