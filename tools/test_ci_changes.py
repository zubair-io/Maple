"""Selector regressions, including immutable event ranges in real Git repos."""

import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import ci_changes as ci

SCRIPT = Path(ci.__file__).resolve()


class ClassificationTests(unittest.TestCase):
    def test_dependencies(self):
        cases = {
            "src/raw-pipeline/raw-core/src/lib.rs": ci.ALL,
            "src/raw-pipeline/Cargo.lock": ci.ALL,
            "src/api/src/routes/assets.ts": {"api", "maple", "web"},
            "src/maple/package.json": {"api", "maple", "web"},
            "src/web/package.json": {"api", "web"},
            "src/web/projects/maple/src/main.ts": {"api", "web"},
            "src/windows/Maple.WinUI/App.xaml.cs": {"windows"},
            "src/windows/Maple.WinUI/Themes/Tokens.xaml": {"windows", "codegen"},
            "src/windows/Maple.WinUI/Generated/ExportRecipe.g.cs": {
                "windows",
                "codegen",
            },
            "src/web/projects/maple-common/src/lib/generated/ui-tokens.ts": {
                "api",
                "web",
                "codegen",
            },
            "src/api/src/generated/color-labels.generated.ts": {
                "api",
                "maple",
                "web",
                "codegen",
            },
            "src/apple/Maple/App.swift": {"codegen"},
            "src/apple/Packages/MapleCore/Package.swift": {"codegen"},
            "docs/features.md": set(),
            "docs/design/maple-ui/components/slider.md": {"web"},
            "README.md": set(),
            "AGENTS.md": set(),
            "CLAUDE.md": set(),
            "LICENSE": set(),
            "tools/release_handoff.py": set(),
            "tools/test_release_control.py": set(),
            "tools/sync-release-version.sh": ci.ALL,
            "tools/codegen.sh": ci.ALL,
            "tools/codegen/helper.py": ci.ALL,
            "tools/ci_changes.py": ci.ALL,
            "tools/qualification/record.sh": ci.ALL,
            "test-fixtures/qualification/record.json": ci.ALL,
            "src/scripts/derive_agx_lut.py": ci.ALL,
            "src/apple/scripts/build-xcframework.sh": ci.ALL,
            "src/apple/ci_scripts/ci_post_clone.sh": ci.ALL,
            "src/windows/scripts/build-windows.sh": ci.ALL,
            "src/api/scripts/build-raw-ffi.sh": ci.ALL,
            ".github/workflows/web.yml": ci.ALL,
            ".github/actions/setup/action.yml": ci.ALL,
            "some/new/domain.txt": ci.ALL,
            "README.md/unexpected": ci.ALL,
            "src/web/../unknown": ci.ALL,
            "": ci.ALL,
        }
        cases.update({path: {"codegen"} for path in ci.CODEGEN_DOCS})
        for path, expected in cases.items():
            with self.subTest(path=path):
                self.assertEqual(set(ci.dependencies(path)), set(expected))

    def test_union_and_empty(self):
        result, _ = ci.classify_paths(["docs/testing.md", "src/web/a", "src/windows/b"])
        self.assertEqual(
            {key for key, value in result.items() if value}, {"api", "web", "windows"}
        )
        self.assertTrue(all(ci.classify_paths([])[0].values()))

    def test_cross_tree_inputs_and_boundaries(self):
        apple = "src/apple/"
        assets = apple + "Maple/Assets.xcassets/"
        cases = {
            apple
            + "Packages/MapleCore/Sources/MapleCore/Resources/builtin-presets.json": {
                "api",
                "web",
                "maple",
                "codegen",
            },
            apple + "MapleUITests/Goldens/.calibration/a.png": ci.ALL,
            apple + "MapleUITests/Goldens/.calibration/expected.json": ci.ALL,
            apple + "MapleUITests/Goldens/other.png": {"codegen"},
            assets + "LaunchLogo.imageset/launchlogo_2x.png": {"web", "codegen"},
            assets + "Other.imageset/maple512.png": {"codegen"},
            "docs/design/maple-ui/components/nested/README.md": {"web"},
            "docs/design/maple-ui/components-other/slider.md": set(),
            "src/api/src/routes/xmp.sidecar-contract.test.ts": {
                "api",
                "web",
                "maple",
                "codegen",
            },
        }
        cases.update(
            {
                assets + f"AppIcon.appiconset/maple{size}.png": {"web", "codegen"}
                for size in (16, 32, 64, 128, 256, 512, 1024)
            }
        )
        for path, expected in cases.items():
            with self.subTest(path=path):
                self.assertEqual(set(ci.dependencies(path)), set(expected))

    def test_metadata_exclusions_are_root_only(self):
        for path in ci.METADATA:
            with self.subTest(path=path):
                self.assertFalse(ci.dependencies(path))
                self.assertEqual(ci.dependencies("src/web/" + path), {"api", "web"})
                self.assertEqual(
                    ci.dependencies("src/raw-pipeline/vendor/pkg/" + path), ci.ALL
                )
                self.assertEqual(ci.dependencies("unknown/" + path), ci.ALL)

    def test_api_imported_web_sources(self):
        root = SCRIPT.parent.parent
        for consumer in ("indexer/id.ts", "presets/builtin-presets-parity.test.ts"):
            source = root / "src/api/src" / consumer
            imports = set(re.findall(r"from '([^']*web/[^']+)'", source.read_text()))
            self.assertTrue(imports, consumer)
            for imported in imports:
                path = (source.parent / imported).resolve().relative_to(root).as_posix()
                with self.subTest(consumer=consumer, path=path):
                    self.assertEqual(ci.dependencies(path), {"api", "web"})

    def test_codegen_evidence_corpora_remain_covered(self):
        registry = (
            SCRIPT.parent.parent
            / "src/raw-pipeline/raw-core/src/capability_registry/mod.rs"
        )
        source = registry.read_text().split("fn corpus(", 1)[1]
        paths = set(re.findall(r'"((?:src|test-fixtures)/[^"\n]+)"', source))
        self.assertIn("src/api/src/routes/xmp.sidecar-contract.test.ts", paths)
        for path in paths:
            with self.subTest(path=path):
                self.assertIn("codegen", ci.dependencies(path))

    def test_codegen_script_paths_remain_covered(self):
        script = (SCRIPT.parent / "codegen.sh").read_text()
        paths = set(re.findall(r"(?:src|docs|test-fixtures)/[\w/+.-]+", script))
        self.assertTrue(ci.CODEGEN_DOCS <= paths)
        for path in paths:
            with self.subTest(path=path):
                self.assertIn("codegen", ci.dependencies(path))

    def test_invalid_events_do_not_invoke_git(self):
        sha = "a" * 40
        cases = [
            ("push", {}),
            ("push", None),
            ("push", []),
            ("push", {"before": "0" * 40, "after": sha}),
            ("push", {"before": sha, "after": "--help"}),
            ("push", {"before": "$(touch unsafe)", "after": sha}),
            ("push", {"before": sha, "after": "abcd"}),
            ("push", {"before": sha, "after": sha + "\n"}),
            ("pull_request", {}),
            ("pull_request", {"pull_request": {"head": {"sha": sha}}}),
            (
                "pull_request",
                {"pull_request": {"head": {"ref": "feature", "sha": sha}}},
            ),
        ]
        with patch.object(ci, "git") as git:
            for name, event in cases:
                with self.subTest(name=name, event=event):
                    self.assertTrue(all(ci.select(name, event)[0].values()))
            git.assert_not_called()

    def test_event_and_release_overrides(self):
        with patch.object(ci, "git") as git:
            for name in (
                "workflow_dispatch",
                "workflow_call",
                "schedule",
                "",
                "merge_group",
            ):
                self.assertTrue(all(ci.select(name, {})[0].values()))
            result, reason = ci.select(
                "pull_request",
                {"pull_request": {"head": {"ref": "release/next-v1.2.3"}}},
            )
            self.assertTrue(all(result.values()))
            self.assertIn("Release PR", reason)
            git.assert_not_called()

    def test_git_failures_and_malformed_diff_select_all(self):
        event = {"before": "a" * 40, "after": "b" * 40}
        failures = (
            FileNotFoundError("git unavailable"),
            subprocess.TimeoutExpired("git", 60),
            subprocess.CalledProcessError(1, "git"),
        )
        for failure in failures:
            with (
                self.subTest(failure=failure),
                patch.object(ci, "git", side_effect=failure),
            ):
                self.assertTrue(all(ci.select("push", event)[0].values()))
        for raw in (b"docs/file.md", b"docs/a\0\0docs/b\0"):
            with patch.object(ci, "git", side_effect=[b"commit\n", b"commit\n", raw]):
                self.assertTrue(all(ci.select("push", event)[0].values()))


class GitTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name)
        self.git("init", "-q")
        self.git("config", "user.name", "Selector Test")
        self.git("config", "user.email", "selector@example.invalid")
        self.git("config", "commit.gpgsign", "false")
        self.git("config", "core.hooksPath", str(self.repo / "no-hooks"))
        self.base = self.commit("README.md")

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.repo).decode().strip()

    def commit(self, path):
        target = self.repo / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(path + "\n")
        self.git("add", "--", path)
        self.git("commit", "-qm", "fixture")
        return self.git("rev-parse", "HEAD")

    def push(self, before, after):
        return ci.select("push", {"before": before, "after": after}, self.repo)

    def pr(self, base, head):
        return ci.select(
            "pull_request",
            {
                "pull_request": {
                    "base": {"sha": base, "ref": "main"},
                    "head": {"sha": head, "ref": "feature"},
                }
            },
            self.repo,
        )

    def assert_selected(self, result, expected):
        self.assertEqual(
            {key for key, value in result[0].items() if value}, set(expected)
        )

    def test_push_entire_multicommit_range(self):
        self.commit("src/windows/app.cs")
        head = self.commit("src/web/app.ts")
        self.assert_selected(self.push(self.base, head), {"api", "windows", "web"})

    def test_deletion_and_cross_domain_rename(self):
        before = self.commit("src/api/source.ts")
        destination = self.repo / "docs/moved.md"
        destination.parent.mkdir()
        (self.repo / "src/api/source.ts").rename(destination)
        self.git("add", "-A")
        self.git("commit", "-qm", "rename")
        self.assert_selected(
            self.push(before, self.git("rev-parse", "HEAD")), {"api", "maple", "web"}
        )
        before = self.commit("src/windows/deleted.cs")
        (self.repo / "src/windows/deleted.cs").unlink()
        self.git("add", "-A")
        self.git("commit", "-qm", "delete")
        self.assert_selected(
            self.push(before, self.git("rev-parse", "HEAD")), {"windows"}
        )

    def test_rename_includes_destination(self):
        before = self.commit("src/windows/source.cs")
        destination = self.repo / "src/web/destination.ts"
        destination.parent.mkdir(parents=True)
        (self.repo / "src/windows/source.cs").rename(destination)
        self.git("add", "-A")
        self.git("commit", "-qm", "rename")
        self.assert_selected(
            self.push(before, self.git("rev-parse", "HEAD")), {"api", "windows", "web"}
        )

    def test_pr_merge_base_ignores_base_only_changes_and_ref_drift(self):
        head = self.commit("src/web/app.ts")
        self.git("checkout", "-q", "--detach", self.base)
        event_base = self.commit("src/windows/base-only.cs")
        self.git("checkout", "-q", "--detach", head)
        drift = self.commit("src/raw-pipeline/later.rs")
        self.git("update-ref", "refs/remotes/origin/main", drift)
        self.assert_selected(self.pr(event_base, head), {"api", "web"})

    def test_missing_objects_empty_diff_and_non_commit(self):
        blob = self.git("rev-parse", "HEAD:README.md")
        for before, head in (
            (self.base, "f" * 40),
            (self.base, self.base),
            (blob, self.base),
        ):
            with self.subTest(before=before, head=head):
                self.assert_selected(self.push(before, head), ci.ALL)

    def test_unrelated_histories(self):
        self.git("checkout", "-q", "--orphan", "unrelated")
        head = self.commit("src/web/new.ts")
        self.assert_selected(self.pr(self.base, head), ci.ALL)

    def test_filenames_are_nul_delimited_and_never_shell_code(self):
        head = self.commit("src/web/line\nbreak\t$(touch PWNED) `touch BAD`.ts")
        self.assert_selected(self.push(self.base, head), {"api", "web"})
        self.assertFalse((self.repo / "PWNED").exists())
        self.assertFalse((self.repo / "BAD").exists())

    def test_cli_outputs_append_and_summary_explains_selection(self):
        head = self.commit("docs/guide.md")
        event_path = self.repo / "event.json"
        output = self.repo / "output"
        summary = self.repo / "summary"
        output.write_text("existing=true\n")
        summary.write_text("Earlier summary\n")
        env = {
            **os.environ,
            "GITHUB_EVENT_NAME": "push",
            "GITHUB_EVENT_PATH": str(event_path),
            "GITHUB_OUTPUT": str(output),
            "GITHUB_STEP_SUMMARY": str(summary),
        }
        event_path.write_text(json.dumps({"before": self.base, "after": head}))
        subprocess.run(
            [sys.executable, str(SCRIPT)],
            cwd=self.repo,
            env=env,
            check=True,
            capture_output=True,
        )
        self.assertEqual(
            output.read_text(),
            "existing=true\n" + "".join(f"{key}=false\n" for key in ci.CONSUMERS),
        )
        self.assertIn("Earlier summary\n", summary.read_text())
        self.assertIn("Classified 1 changed paths", summary.read_text())
        for payload in ("{bad json", "null", "{}"):
            event_path.write_text(payload)
            subprocess.run(
                [sys.executable, str(SCRIPT)],
                cwd=self.repo,
                env=env,
                check=True,
                capture_output=True,
            )
            self.assertTrue(
                output.read_text().endswith(
                    "".join(f"{key}=true\n" for key in ci.CONSUMERS)
                )
            )
        event_path.unlink()
        subprocess.run(
            [sys.executable, str(SCRIPT)],
            cwd=self.repo,
            env=env,
            check=True,
            capture_output=True,
        )
        self.assertIn("Event payload unavailable", summary.read_text())


if __name__ == "__main__":
    unittest.main()
