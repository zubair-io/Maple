"""Whole-diff selection: dependency selector plus raw-pipeline's paths (#5406)."""

import re
import unittest
from pathlib import Path

import yaml

import ci_changes as ci

ROOT = Path(ci.__file__).resolve().parent.parent
PLATFORM_BUILDS = ("android", "windows")

# PR #5401: server code, docs, the regenerated capability registry and the
# API sidecar contract record it re-recorded.
SERVER_ONLY_PR = (
    "docs/capability-registry.json",
    "docs/capability-registry.md",
    "docs/features.md",
    "docs/indexer-enrichment.md",
    "src/api/.oxlintrc.json",
    "src/api/src/db/repos/assets.mapleignore.ts",
    "src/api/src/fs/browse.ts",
    "src/api/src/fs/hidden-marker.ts",
    "src/api/src/fs/mapleignore-guard.ts",
    "src/api/src/fs/mapleignore.test.ts",
    "src/api/src/fs/mapleignore.ts",
    "src/api/src/fs/sidecar-io.ts",
    "src/api/src/library/asset-trash.ts",
    "src/api/src/library/folder-listing.ts",
    "src/api/src/library/folder-trash.ts",
    "src/api/src/library/relocate-asset.ts",
    "src/api/src/library/relocate-geo.ts",
    "src/api/src/library/upload-replacement.ts",
    "src/api/src/routes/assets/trash.ts",
    "src/api/src/routes/folders.mapleignore.test.ts",
    "src/api/src/routes/folders.ts",
    "src/api/src/routes/folders.upload.ts",
    "src/api/src/routes/library/folder.test.ts",
    "src/api/src/workers/dedupe.process-asset.ts",
    "src/api/src/workers/discover/folder-ignore.test.ts",
    "src/api/src/workers/discover/folder-ignore.ts",
    "src/api/src/workers/discover/handle-event.ts",
    "src/api/src/workers/discover/sweeper.ts",
    "src/api/src/workers/discover/types.ts",
    "src/api/src/workers/migration/canonical-backup-sidecars.ts",
    "src/api/src/workers/migration/move-backup-asset.ts",
    "src/api/src/workers/missing-reaper.control.test.ts",
    "src/api/src/workers/missing-reaper.ts",
    "src/api/src/workers/trash-gc.ts",
    "test-fixtures/qualification/sidecar_contract_api.json",
)
RAW_PIPELINE_RECORDS = (
    "test-fixtures/qualification/synthetic_grey.json",
    "test-fixtures/qualification/color_chart.json",
    "test-fixtures/qualification/grey_adjustments.json",
    "test-fixtures/qualification/grey_dcp.json",
    "test-fixtures/qualification/gpu_chain_parity_lavapipe.json",
    "test-fixtures/qualification/gpu_chain_parity_metal.json",
    "test-fixtures/qualification/lensfun-reference.json",
    "test-fixtures/qualification/lensfun-vs-lcp.json",
)


def github_glob(pattern):
    escaped = re.escape(pattern).replace(r"\*\*", "\0").replace(r"\*", "[^/]*")
    return re.compile(escaped.replace("\0", ".*").replace(r"\?", "[^/]") + r"\Z")


def raw_pipeline_triggered(event, paths):
    """GitHub path filters: patterns apply in order and the last match wins."""
    workflow = yaml.safe_load((ROOT / ".github/workflows/raw-pipeline.yml").read_text())
    patterns = [
        (not pattern.startswith("!"), github_glob(pattern.removeprefix("!")))
        for pattern in workflow[True][event]["paths"]
    ]

    def included(path):
        verdicts = [keep for keep, glob in patterns if glob.match(path)]
        return bool(verdicts) and verdicts[-1]

    return any(included(path) for path in paths)


class PathScenarioTests(unittest.TestCase):
    def selected(self, paths):
        outputs, _ = ci.classify_paths(list(paths))
        return {name for name, value in outputs.items() if value}

    def assert_raw_pipeline(self, paths, expected):
        for event in ("pull_request", "push"):
            with self.subTest(event=event):
                self.assertEqual(raw_pipeline_triggered(event, paths), expected)

    def test_server_only_pr_skips_platform_builds_and_gpu(self):
        selected = self.selected(SERVER_ONLY_PR)
        self.assertTrue({"api", "maple", "web", "codegen"} <= selected)
        self.assertFalse(selected & set(PLATFORM_BUILDS))
        self.assertFalse(selected & {"release", "ci"})
        self.assert_raw_pipeline(SERVER_ONLY_PR, False)

    def test_server_only_pr_selects_swift_only_through_its_fixture_closure(self):
        closure, complete = ci.swift_api_closure()
        booted = [path for path in SERVER_ONLY_PR if path in closure]
        self.assertTrue(complete)
        self.assertIn("src/api/src/fs/browse.ts", booted)
        self.assertIn("swift", self.selected(SERVER_ONLY_PR))
        outside = [path for path in SERVER_ONLY_PR if path not in closure]
        self.assertEqual(self.selected(outside), {"api", "maple", "web", "codegen"})

    def test_sidecar_contract_records_select_only_their_suite(self):
        cases = {
            "test-fixtures/qualification/sidecar_contract_api.json": {"api", "codegen"},
            "test-fixtures/qualification/sidecar_contract_apple.json": {
                "swift",
                "codegen",
            },
        }
        for path, expected in cases.items():
            with self.subTest(path=path):
                self.assertEqual(self.selected([path]), expected)
                self.assert_raw_pipeline([path], False)

    def test_raw_pipeline_exclusions_match_the_selector_records(self):
        workflow = yaml.safe_load(
            (ROOT / ".github/workflows/raw-pipeline.yml").read_text()
        )
        for event in ("pull_request", "push"):
            with self.subTest(event=event):
                excluded = {
                    pattern.removeprefix("!")
                    for pattern in workflow[True][event]["paths"]
                    if pattern.startswith("!")
                }
                self.assertEqual(excluded, set(ci.SIDECAR_CONTRACT_RECORDS))

    def test_raw_pipeline_change_runs_gpu_and_every_platform_build(self):
        for path in (
            "src/raw-pipeline/raw-gpu/src/shaders/tone.wgsl",
            "src/raw-pipeline/raw-ffi/src/lib.rs",
            "src/raw-pipeline/raw-core/src/color/mod.rs",
        ):
            with self.subTest(path=path):
                self.assertEqual(self.selected([path]), set(ci.BUILDS))
                self.assert_raw_pipeline([path], True)
        mixed = [*SERVER_ONLY_PR, "src/raw-pipeline/raw-core/src/lib.rs"]
        self.assertEqual(self.selected(mixed), set(ci.BUILDS))
        self.assert_raw_pipeline(mixed, True)

    def test_raw_pipeline_records_keep_their_gates(self):
        for path in RAW_PIPELINE_RECORDS:
            with self.subTest(path=path):
                self.assertEqual(self.selected([path]), set(ci.BUILDS))
                self.assert_raw_pipeline([path], True)
        unknown = "test-fixtures/qualification/new_suite.json"
        self.assertEqual(self.selected([unknown]), set(ci.BUILDS))
        self.assert_raw_pipeline([unknown], True)

    def test_windows_change_runs_windows_without_gpu(self):
        path = "src/windows/Maple.WinUI/App.xaml.cs"
        self.assertEqual(self.selected([path]), {"windows"})
        self.assert_raw_pipeline([path], False)

    def test_glob_translation(self):
        self.assertTrue(github_glob("src/a/**").match("src/a/b/c.rs"))
        self.assertTrue(github_glob("a/*.json").match("a/b.json"))
        self.assertFalse(github_glob("a/*.json").match("a/b/c.json"))
        self.assertFalse(github_glob("a/*.json").match("a/b.jsonx"))


if __name__ == "__main__":
    unittest.main()
