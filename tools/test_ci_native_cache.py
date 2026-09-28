"""Isolated native artifact cache tests; no native compiler or binaries required."""

import contextlib
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

HELPER = Path(__file__).with_name("native_package_cache.py").resolve()
SPEC = importlib.util.spec_from_file_location("native_package_cache", HELPER)
cache = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cache)
TARGET = "x86_64-unknown-linux-musl"
PLATFORM = "linux-x64-musl"
DIGEST = "a" * 64


class NativeCacheTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.env = patch.dict(os.environ, {"CI": "false", "GITHUB_ACTIONS": "false"})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.git("init", "-q")
        self.git("config", "user.email", "cache@example.invalid")
        self.git("config", "user.name", "Cache tests")
        self.write("src/maple/package.json", "package-v1\n")
        self.write("src/maple/scripts/audit-linkage.sh", "audit-v1\n")
        self.write("src/raw-pipeline/Cargo.toml", "native-v1\n")
        self.write("tools/build.sh", "build-v1\n")
        self.commit()
        self.versions = {
            ("rustc", "-Vv"): b"rustc 1.90\nhost: x86_64-unknown-linux-gnu\n",
            ("zig", "version"): b"0.15\n",
            ("cargo", "zigbuild", "--version"): b"cargo-zigbuild 0.20\n",
        }
        self.args = type(
            "Args",
            (),
            {
                "target": TARGET,
                "platform": PLATFORM,
                "fingerprint": DIGEST,
            },
        )()
        self.directory = self.root / ".native-package-cache"
        self.release = self.root / "src/raw-pipeline/target" / TARGET / "release"
        self.names = ("libraw_ffi.so", f"raw-napi.{PLATFORM}.node")
        self.release.mkdir(parents=True)
        for name in self.names:
            (self.release / name).write_bytes(b"native-binary-" + name.encode())

    def git(self, *args):
        return subprocess.check_output(
            ["git", *args], cwd=self.root, stderr=subprocess.PIPE
        )

    def write(self, name, text):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def commit(self):
        # Only source fixtures, never generated artifacts.
        self.git("add", "src/maple", "src/raw-pipeline/Cargo.toml", "tools")
        self.git("commit", "-qm", "fixture")

    def fingerprint(self, target=TARGET, platform=PLATFORM):
        real_command = cache.command

        def run(root, *args):
            if args[0] == "git":
                return real_command(root, *args)
            self.assertEqual(root, self.root)
            return self.versions[args]

        with patch.object(cache, "command", side_effect=run):
            return cache.fingerprint(self.root, target, platform)

    def stage(self):
        cache.stage(self.args, self.directory, self.release, self.names)

    def restore(self):
        with contextlib.redirect_stderr(io.StringIO()):
            return cache.restore(self.args, self.directory, self.release, self.names)

    def cli(self, action, *extra):
        return subprocess.run(
            [
                sys.executable,
                str(HELPER),
                action,
                "--target",
                self.args.target,
                "--platform",
                self.args.platform,
                "--fingerprint",
                DIGEST,
                "--cache-dir",
                str(self.directory),
                *extra,
            ],
            cwd=self.root,
            capture_output=True,
            text=True,
            check=False,
        )

    def test_cli_round_trip_all_seven_pairs(self):
        for target, (platform, library) in cache.PAIRS.items():
            with self.subTest(target=target):
                self.args.target, self.args.platform = target, platform
                self.directory = self.root / ("cache-" + platform)
                release = self.root / "src/raw-pipeline/target" / target / "release"
                release.mkdir(parents=True, exist_ok=True)
                names = (library, f"raw-napi.{platform}.node")
                for name in names:
                    (release / name).write_bytes(name.encode())
                result = self.cli("stage")
                self.assertEqual(result.returncode, 0, result.stderr)
                for name in names:
                    (release / name).unlink()
                output = self.root / (platform + ".output")
                result = self.cli("restore", "--github-output", str(output))
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(output.read_text(), "reused=true\n")
                for name in names:
                    self.assertEqual((release / name).read_bytes(), name.encode())

    def test_missing_cache_cli_is_successful_miss(self):
        output = self.root / "output"
        result = self.cli("restore", "--github-output", str(output))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(output.read_text(), "reused=false\n")

    def test_bad_entries_never_replace_either_output(self):
        for damage in (
            "missing",
            "empty",
            "corrupt",
            "symlink",
            "directory",
            "extra",
            "invalid-json",
            "missing-manifest",
            "manifest-symlink",
        ):
            with (
                self.subTest(damage=damage),
                tempfile.TemporaryDirectory(dir=self.root) as tmp,
            ):
                self.directory = Path(tmp) / "cache"
                self.stage()
                binary = self.directory / self.names[1]
                manifest = self.directory / "manifest.json"
                if damage in ("missing", "symlink", "directory"):
                    binary.unlink()
                if damage == "empty":
                    binary.write_bytes(b"")
                elif damage == "corrupt":
                    binary.write_bytes(b"corrupt")
                elif damage == "symlink":
                    binary.symlink_to(self.release / self.names[1])
                elif damage == "directory":
                    binary.mkdir()
                elif damage == "extra":
                    (self.directory / "unexpected").write_bytes(b"extra")
                elif damage == "invalid-json":
                    manifest.write_text("{")
                elif damage in ("missing-manifest", "manifest-symlink"):
                    manifest.unlink()
                    if damage == "manifest-symlink":
                        manifest.symlink_to(self.release / self.names[0])
                before = {
                    name: (self.release / name).read_bytes() for name in self.names
                }
                self.assertFalse(self.restore())
                self.assertEqual(
                    before,
                    {name: (self.release / name).read_bytes() for name in self.names},
                )

    def test_manifest_mismatches(self):
        self.stage()
        path = self.directory / "manifest.json"
        original = json.loads(path.read_text())
        for field, value in (
            ("target", "../escape"),
            ("platform", "other"),
            ("fingerprint", "b" * 64),
            ("version", True),
            ("files", {"../escape": "a" * 64}),
            ("extra", 1),
        ):
            with self.subTest(field=field):
                path.write_text(json.dumps({**original, field: value}))
                self.assertFalse(self.restore())
        for text in ("[]", "null", '{"version":1,"version":1}'):
            path.write_text(text)
            self.assertFalse(self.restore())

    def test_symlink_cache_directory_and_parent(self):
        self.stage()
        actual = self.directory
        for parent in (False, True):
            link = self.root / ("parent-link" if parent else "cache-link")
            link.symlink_to(self.root if parent else actual, target_is_directory=True)
            self.directory = link / actual.name if parent else link
            self.assertFalse(self.restore())

    def test_rename_failure_rolls_back(self):
        self.stage()
        for name in self.names:
            (self.release / name).write_bytes(b"previous")
        real_replace = os.replace

        def replace(source, dest):
            if Path(source).name == self.names[1] and Path(dest).parent == self.release:
                raise OSError("injected replacement failure")
            return real_replace(source, dest)

        with patch.object(cache.os, "replace", side_effect=replace):
            self.assertFalse(self.restore())
        for name in self.names:
            self.assertEqual((self.release / name).read_bytes(), b"previous")

    def test_stage_missing_binary_publishes_nothing(self):
        (self.release / self.names[1]).unlink()
        with self.assertRaises(OSError):
            self.stage()
        self.assertFalse(self.directory.exists())

    def test_excluded_package_changes_and_untracked_files(self):
        initial = self.fingerprint()
        self.write("src/maple/package.json", "package-v2\n")
        self.write("untracked-native.rs", "untracked\n")
        self.assertEqual(initial, self.fingerprint())
        self.commit()
        self.assertEqual(initial, self.fingerprint())

    def test_included_changes_rejected_then_invalidate(self):
        for name in (
            "src/raw-pipeline/Cargo.toml",
            "tools/build.sh",
            "src/maple/scripts/audit-linkage.sh",
        ):
            initial = self.fingerprint()
            self.write(name, "changed\n")
            with self.assertRaisesRegex(ValueError, "dirty"):
                self.fingerprint()
            self.git("add", name)
            with self.assertRaisesRegex(ValueError, "dirty"):
                self.fingerprint()
            self.commit()
            self.assertNotEqual(initial, self.fingerprint())

    def test_modes_and_tracked_deletion_invalidate(self):
        initial = self.fingerprint()
        self.git("update-index", "--chmod=+x", "tools/build.sh")
        with self.assertRaises(ValueError):
            self.fingerprint()
        self.git("commit", "-qm", "mode")
        (self.root / "tools/build.sh").chmod(0o755)
        self.assertNotEqual(initial, self.fingerprint())
        self.git("rm", "tools/build.sh")
        with self.assertRaises(ValueError):
            self.fingerprint()

    def test_tool_versions_runner_and_compiler_environment(self):
        initial = self.fingerprint()
        for tool in self.versions:
            old = self.versions[tool]
            self.versions[tool] = old + b"changed"
            self.assertNotEqual(initial, self.fingerprint())
            self.versions[tool] = old
        for field in (
            *cache.RUNNER_FIELDS,
            "RUSTFLAGS",
            "CARGO_ENCODED_RUSTFLAGS",
            "CC",
            "CXX",
            "CFLAGS",
            "CXXFLAGS",
            "CARGO_TARGET_X_LINKER",
        ):
            with self.subTest(field=field), patch.dict(os.environ, {field: "changed"}):
                self.assertNotEqual(initial, self.fingerprint())
        self.assertNotEqual(
            initial, self.fingerprint("aarch64-unknown-linux-musl", "linux-arm64-musl")
        )

    def test_ci_image_version_required_and_staging_main_only(self):
        with patch.dict(
            os.environ,
            {"CI": "true", "ImageVersion": "", "GITHUB_REF": "refs/pull/1/merge"},
        ):
            with self.assertRaisesRegex(ValueError, "ImageVersion"):
                self.fingerprint()
            with self.assertRaisesRegex(ValueError, "main"):
                self.stage()
        with (
            patch.dict(
                os.environ,
                {
                    "CI": "true",
                    "GITHUB_REF": "refs/heads/main",
                    "GITHUB_EVENT_NAME": "pull_request",
                },
            ),
            self.assertRaisesRegex(ValueError, "workflow_dispatch"),
        ):
            self.stage()
        with patch.dict(
            os.environ,
            {
                "CI": "true",
                "GITHUB_REF": "refs/heads/main",
                "GITHUB_EVENT_NAME": "workflow_dispatch",
            },
        ):
            self.stage()

    def test_fingerprint_cli_outputs_and_failure_emits_no_key(self):
        output = self.root / "output"
        argv = [
            "fingerprint",
            "--target",
            TARGET,
            "--platform",
            PLATFORM,
            "--github-output",
            str(output),
        ]
        with (
            patch.object(Path, "cwd", return_value=self.root),
            patch.object(cache, "fingerprint", return_value=DIGEST),
        ):
            self.assertEqual(cache.main(argv), 0)
        self.assertEqual(
            output.read_text(),
            f"key=native-package-v1-{DIGEST}\nfingerprint={DIGEST}\n",
        )
        output.unlink()
        with (
            patch.object(Path, "cwd", return_value=self.root),
            patch.object(cache, "fingerprint", side_effect=FileNotFoundError("rustc")),
            contextlib.redirect_stderr(io.StringIO()),
        ):
            self.assertEqual(cache.main(argv), 1)
        self.assertFalse(output.exists())

    def test_invalid_target_platform_rejected(self):
        self.args.platform = "../../escape"
        self.assertNotEqual(self.cli("stage").returncode, 0)
        self.assertFalse(self.directory.exists())

    def test_ci_stage_rechecks_fingerprint_before_publishing(self):
        argv = [
            "stage",
            "--target",
            TARGET,
            "--platform",
            PLATFORM,
            "--fingerprint",
            DIGEST,
            "--cache-dir",
            str(self.directory),
        ]
        for result in ("b" * 64, ValueError("tracked inputs dirty"), DIGEST):
            with (
                self.subTest(result=result),
                patch.dict(
                    os.environ,
                    {
                        "CI": "true",
                        "ImageVersion": "test-image",
                        "GITHUB_REF": "refs/heads/main",
                        "GITHUB_EVENT_NAME": "workflow_dispatch",
                    },
                ),
                patch.object(Path, "cwd", return_value=self.root),
                patch.object(
                    cache,
                    "fingerprint",
                    **(
                        {"side_effect": result}
                        if isinstance(result, Exception)
                        else {"return_value": result}
                    ),
                ) as probe,
                patch.object(cache, "stage") as publish,
                contextlib.redirect_stderr(io.StringIO()),
            ):
                self.assertEqual(cache.main(argv), 0 if result == DIGEST else 1)
                probe.assert_called_once_with(self.root, TARGET, PLATFORM)
                if result == DIGEST:
                    publish.assert_called_once()
                else:
                    publish.assert_not_called()
                self.assertFalse(self.directory.exists())


if __name__ == "__main__":
    unittest.main()
