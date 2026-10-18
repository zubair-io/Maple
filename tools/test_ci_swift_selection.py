"""Swift (macOS runner) job selection: Apple inputs, shared fixtures, API fixture closure."""

import tempfile
import unittest
from pathlib import Path

import ci_changes as ci

SCRIPT = Path(ci.__file__).resolve()


class SwiftSelectionTests(unittest.TestCase):
    """macOS runners are the CI bottleneck; Swift jobs run only when Swift can be affected."""

    def swift(self, *paths):
        return ci.classify_paths(list(paths))[0]["swift"]

    def test_api_only_diff_skips_swift(self):
        for path in (
            "src/api/src/routes/assets.ts",
            "src/api/tests/assets-restore.test.ts",
            "src/api/tests/fixtures/other-server.ts",
        ):
            with self.subTest(path=path):
                self.assertFalse(self.swift(path))

    def test_api_fixtures_booted_by_swift_tests_select_swift(self):
        for path in (
            "src/api/tests/fixtures/file-provider-restart.ts",
            "src/api/tests/fixtures/unified-folder-server.ts",
            "src/api/tests/browser/workflow-server.ts",
            "src/api/src/routes/changes.ts",
            "src/api/package.json",
            "src/api/bun.lock",
        ):
            with self.subTest(path=path):
                self.assertTrue(self.swift(path))

    def test_shared_fixture_diff_runs_swift(self):
        for path in (
            "test-fixtures/file-operations/cases.json",
            "test-fixtures/xmp-namespaces/namespaces.xmp",
            "test-fixtures/export-recipes/interchange-cases.json",
            "test-fixtures/local-adjustments/mask.json",
            ".github/swift-regressions/run.txt",
            ".github/swift-regressions/excluded.txt",
            "docs/design/maple-ui/apple-icon-inventory.json",
        ):
            with self.subTest(path=path):
                self.assertTrue(self.swift(path))

    def test_native_core_diff_runs_swift(self):
        for path in (
            "src/raw-pipeline/raw-ffi/src/lib.rs",
            "src/raw-pipeline/raw-core/src/color/mod.rs",
            "src/raw-pipeline/Cargo.lock",
        ):
            with self.subTest(path=path):
                self.assertTrue(self.swift(path))

    def test_apple_source_and_recipe_interchange_inputs_run_swift(self):
        for path in (
            "src/apple/Maple/App.swift",
            "src/apple/Packages/MapleCore/Sources/MapleCore/Foo.swift",
            "src/apple/Packages/MapleUI/Sources/MapleUI/Resources/font.ttf",
            "src/apple/Maple.xcodeproj/project.pbxproj",
            "src/web/package.json",
            "src/web/bun.lock",
            "src/web/e2e/recipe-interchange/spec.ts",
            "src/web/playwright.recipe-interchange.config.ts",
            "src/web/projects/maple-common/src/lib/export/export-recipe-store.ts",
            "src/web/projects/maple-common/src/lib/generated/export-recipe.generated.ts",
            "src/scripts/test_export_recipe_interchange.sh",
            "tools/check-swift-regressions-coverage.py",
            ".github/workflows/apple.yml",
        ):
            with self.subTest(path=path):
                self.assertTrue(self.swift(path))

    def test_docs_metadata_and_unrelated_consumers_skip_swift(self):
        for path in (
            "docs/features.md",
            "docs/testing.md",
            "docs/design/maple-ui/components/slider.md",
            "README.md",
            "src/web/projects/maple/src/main.ts",
            "src/windows/Maple.WinUI/App.xaml.cs",
            "src/android/app/build.gradle.kts",
            "tools/release_handoff.py",
        ):
            with self.subTest(path=path):
                self.assertFalse(self.swift(path))

    def test_mixed_diff_runs_swift_when_any_path_needs_it(self):
        self.assertTrue(
            self.swift("src/api/src/routes/assets.ts", "src/apple/Maple/App.swift")
        )

    def test_uncertain_events_still_run_swift(self):
        self.assertTrue(ci.classify_paths([])[0]["swift"])
        self.assertTrue(self.swift("some/new/domain.txt"))
        self.assertTrue(ci.select("workflow_dispatch", {})[0]["swift"])
        self.assertTrue(
            ci.select(
                "pull_request",
                {"pull_request": {"head": {"ref": "release/next-v1.2.3"}}},
            )[0]["swift"]
        )


class SwiftApiClosureTests(unittest.TestCase):
    def test_modules_imported_by_swift_booted_fixtures_select_swift(self):
        for path in (
            "src/api/src/routes/changes.ts",
            "src/api/src/routes/library/folder.ts",
            "src/api/src/db/repos/changes.repo.ts",
            "src/api/tests/helpers/test-auth.ts",
        ):
            with self.subTest(path=path):
                self.assertIn("swift", ci.dependencies(path))

    def test_closure_members_outside_the_api_tree_select_swift(self):
        parser = "src/web/projects/maple-common/src/lib/addressing/maple-id-parser.ts"
        self.assertIn(parser, ci.swift_api_closure()[0])
        self.assertIn("swift", ci.dependencies(parser))

    def test_local_maple_runtime_package_selects_swift(self):
        for path in (
            "src/maple/package.json",
            "src/maple/dist/index.js",
            "src/maple/src/index.ts",
        ):
            with self.subTest(path=path):
                self.assertIn("swift", ci.dependencies(path))
        for path in ("src/maple/README.md", "src/maple/test/native.test.ts"):
            with self.subTest(path=path):
                self.assertNotIn("swift", ci.dependencies(path))

    def test_unrelated_api_modules_skip_swift(self):
        closure, complete = ci.swift_api_closure()
        self.assertTrue(complete)
        unrelated = "src/api/src/routes/cloudflare.ts"
        if not (SCRIPT.parent.parent / unrelated).exists():
            self.skipTest("fixture module renamed")
        self.assertNotIn(unrelated, closure)
        self.assertNotIn("swift", ci.dependencies(unrelated))

    def test_closure_follows_transitive_relative_imports(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            api = root / "src/api"
            (api / "tests/fixtures").mkdir(parents=True)
            (api / "src/deep").mkdir(parents=True)
            (api / "tests/fixtures/file-provider-restart.ts").write_text(
                "import { a } from '../../src/a.ts';\n"
            )
            (api / "src/a.ts").write_text("export * from './deep/index.ts';\n")
            (api / "src/deep/index.ts").write_text("import './b.js';\n")
            (api / "src/deep/b.ts").write_text("export const b = 1;\n")
            (api / "src/lonely.ts").write_text("export const c = 1;\n")
            for name in ("unified-folder-server.ts",):
                (api / "tests/fixtures" / name).write_text("")
            (api / "tests/browser").mkdir()
            (api / "tests/browser/workflow-server.ts").write_text("")
            closure, complete = ci.swift_api_closure(root)
            self.assertTrue(complete)
            self.assertIn("src/api/src/deep/b.ts", closure)
            self.assertNotIn("src/api/src/lonely.ts", closure)

    def test_deleted_cross_tree_import_selects_swift_for_any_path(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            fixtures = root / "src/api/tests/fixtures"
            fixtures.mkdir(parents=True)
            (fixtures / "file-provider-restart.ts").write_text(
                "import { id } from '../../../web/lib/removed-parser.ts';\n"
            )
            self.assertTrue(
                ci.affects_swift_api("src/web/lib/removed-parser.ts", root)
            )

    def test_unresolvable_import_is_conservative(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            fixtures = root / "src/api/tests/fixtures"
            fixtures.mkdir(parents=True)
            (fixtures / "file-provider-restart.ts").write_text(
                "import { gone } from '../../src/not-there.ts';\n"
            )
            closure, complete = ci.swift_api_closure(root)
            self.assertFalse(complete)
            self.assertTrue(ci.affects_swift_api("src/api/src/anything.ts", root))

    def test_missing_entry_point_is_conservative(self):
        with tempfile.TemporaryDirectory() as temp:
            self.assertFalse(ci.swift_api_closure(Path(temp))[1])


if __name__ == "__main__":
    unittest.main()
