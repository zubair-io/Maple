"""Android dependency, device gate, ABI and bounded setup recovery contracts."""

import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

from android_test_reports import verify
from ci_changes import ALL, classify_paths, dependencies
from ci_result import validate
from test_ci_workflows import ROOT, workflow

SCRIPTS = ROOT / "src/android/scripts"


class AndroidSelectionTests(unittest.TestCase):
    def test_android_inputs_select_the_consumer(self):
        paths = (
            "src/android/app/src/main/java/app/justmaple/aperture/MainActivity.kt",
            "src/android/app/src/main/cpp/bridge.cpp",
            "src/android/app/src/main/cpp/CMakeLists.txt",
            "src/android/app/build.gradle.kts",
            "src/android/gradle/wrapper/gradle-wrapper.properties",
            "src/android/native/Cargo.lock",
            "src/android/native/src/preview.rs",
            "src/android/app/src/main/java/app/justmaple/aperture/generated/UiTokens.kt",
            "src/raw-pipeline/raw-core/src/types.rs",
            "src/raw-pipeline/raw-gpu/src/shaders/present.wgsl",
            "src/raw-pipeline/codegen/src/main.rs",
            "src/raw-pipeline/Cargo.lock",
            "src/raw-pipeline/third_party/rav1d/src/lib.rs",
            "resources/film-luts/velvia.mlut",
            "test-fixtures/android/large-48mp.heic",
            "test-fixtures/batch-transfer/source.dng",
            "test-fixtures/raster-metadata/avif-10.avif",
            "src/apple/MapleUITests/Fixtures/layout/rgb-gradient.png",
            "src/apple/Packages/MapleUI/Sources/MapleUI/Resources/MaterialSymbols/Rounded.ttf",
            "src/apple/Maple/Assets.xcassets/AppIcon.appiconset/maple512.png",
            "src/web/projects/maple-common/src/lib/icons/tool-glyph-shapes.ts",
            "src/android/scripts/build-native.sh",
            "tools/codegen.sh",
            "tools/ci_changes.py",
            "tools/ci_result.py",
            "tools/test_ci_android.py",
            ".github/workflows/android.yml",
            ".github/workflows/ci-changes.yml",
        )
        for path in paths:
            with self.subTest(path=path):
                self.assertTrue(classify_paths([path])[0]["android"])

    def test_actual_staged_assets_remain_required_and_select_android(self):
        gradle = ROOT / "src/android/app/build.gradle.kts"
        paths = re.findall(r'rootProject.file\("([^"]+)"\)', gradle.read_text())
        self.assertGreaterEqual(len(paths), 7)
        for relative in paths:
            path = (ROOT / "src/android" / relative).resolve()
            with self.subTest(path=path):
                self.assertTrue(
                    path.is_file(), "Committed device fixtures may not skip-pass"
                )
                self.assertIn(
                    "android", dependencies(path.relative_to(ROOT).as_posix())
                )

    def test_platform_changes_do_not_expand_to_unrelated_consumers(self):
        for path in (
            "app/build.gradle.kts",
            "native/Cargo.lock",
            "app/src/main/cpp/bridge.cpp",
        ):
            self.assertEqual(dependencies("src/android/" + path), {"android"})
        self.assertEqual(
            dependencies(
                "src/android/app/src/main/java/app/justmaple/aperture/generated/UiTokens.kt"
            ),
            {"android", "codegen"},
        )
        for path in (
            "docs/android.md",
            "src/apple/Maple/App.swift",
            "src/windows/Maple.WinUI/App.xaml.cs",
            "src/web/projects/maple/src/main.ts",
            "src/api/src/routes/assets.ts",
        ):
            with self.subTest(path=path):
                self.assertNotIn("android", dependencies(path))
        self.assertEqual(dependencies("unknown/shared-input"), ALL)
        self.assertEqual(dependencies("test-fixtures/new-corpus/photo.dng"), ALL)


class AndroidWorkflowTests(unittest.TestCase):
    def test_emulator_and_existing_gates_are_required(self):
        config = workflow("android")
        self.assertIsNone(config[True]["pull_request"])
        self.assertEqual(config[True]["push"], {"branches": ["main"]})
        job = config["jobs"]["android-build"]
        self.assertEqual(job["runs-on"], "ubuntu-24.04")
        for step in job["steps"]:
            self.assertNotIn("continue-on-error", step)
        emulator = next(
            s for s in job["steps"] if "emulator-runner@" in s.get("uses", "")
        )
        inputs = emulator["with"]
        self.assertEqual(inputs["api-level"], 36)
        self.assertEqual(inputs["arch"], "x86_64")
        self.assertEqual(inputs["profile"], "pixel_tablet")
        self.assertIn("-gpu swiftshader", inputs["emulator-options"])
        self.assertNotIn("-Vulkan", inputs["emulator-options"])
        self.assertEqual(
            inputs["script"],
            "bash src/android/scripts/test-device-ci.sh x86_64 arm64-v8a,x86_64",
        )
        commands = "\n".join(s.get("run", "") for s in job["steps"])
        for gate in (
            "assembleDebug assembleDebugAndroidTest testDebugUnitTest lintDebug",
            "-PmapleAbis=arm64-v8a,x86_64",
            "cargo test --locked --manifest-path native/Cargo.toml --lib",
            "python3 tools/android_test_reports.py",
            "test -r /dev/kvm && test -w /dev/kvm",
        ):
            self.assertIn(gate, commands)
        reports = next(
            s
            for s in job["steps"]
            if s.get("name") == "Publish Android test reports and device evidence"
        )
        self.assertEqual(reports["if"], "always()")
        self.assertEqual(reports["with"]["if-no-files-found"], "error")
        runner = (SCRIPTS / "test-device-ci.sh").read_text()
        for contract in (
            "trap collect EXIT",
            "wm size 1280x800",
            "wm density 160",
            "connectedDebugAndroidTest",
            "vulkan.level",
            "logcat -d",
            "screencap",
        ):
            self.assertIn(contract, runner)
        self.assertNotIn("connectedDebugAndroidTest ||", runner)

    def test_result_rejects_failed_cancelled_and_skipped_selected_android(self):
        for result in ("failure", "cancelled", "skipped"):
            needs = {
                "changes": {"result": "success", "outputs": {"android": "true"}},
                "android-build": {"result": result},
            }
            with self.subTest(result=result), self.assertRaises(ValueError):
                validate(needs, {"android-build": "android"}, "pull_request")


class AndroidReportTests(unittest.TestCase):
    def test_missing_incomplete_skipped_and_failed_reports_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            with self.assertRaises(ValueError):
                verify(directory, 1)
            report = directory / "TEST-device.xml"
            report.write_text('<testsuite><testcase name="passed"/></testsuite>')
            verify(directory, 1)
            with self.assertRaises(ValueError):
                verify(directory, 37)
            for status in ("skipped", "failure", "error"):
                report.write_text(
                    f"<testsuite><testcase><{status}/></testcase></testsuite>"
                )
                with self.subTest(status=status), self.assertRaises(ValueError):
                    verify(directory, 1)


class AndroidScriptTests(unittest.TestCase):
    def run_script(self, name, *args, fail_until=0):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            binary = root / "bin"
            binary.mkdir()
            commands = root / "commands"
            for name_, text in {
                "sleep": "exit 0",
                "cargo": 'echo "$*" >> "$COMMANDS"',
                "sdkmanager": 'echo "$*" >> "$COMMANDS"\ncount=$(wc -l < "$COMMANDS")\n[ "$count" -gt "$FAIL_UNTIL" ]',
            }.items():
                path = binary / name_
                path.write_text("#!/bin/sh\n" + text + "\n")
                path.chmod(0o755)
            for host in ("darwin-x86_64", "linux-x86_64"):
                toolchain = (
                    root / "ndk/28.2.13676358/toolchains/llvm/prebuilt" / host / "bin"
                )
                toolchain.mkdir(parents=True)
                for target in ("aarch64", "x86_64"):
                    compiler = toolchain / f"{target}-linux-android29-clang"
                    compiler.touch()
                    compiler.chmod(0o755)
            result = subprocess.run(
                ["bash", str(SCRIPTS / name), *args],
                check=False,
                env={
                    **os.environ,
                    "PATH": f"{binary}:{os.environ['PATH']}",
                    "ANDROID_HOME": str(root),
                    "COMMANDS": str(commands),
                    "FAIL_UNTIL": str(fail_until),
                },
                capture_output=True,
                text=True,
                timeout=10,
            )
            return (
                result,
                commands.read_text().splitlines() if commands.exists() else [],
            )

    def test_sdk_retry_is_bounded_and_never_turns_exhaustion_green(self):
        for failures, expected_attempts, success in (
            (0, 1, True),
            (1, 2, True),
            (10, 3, False),
        ):
            with self.subTest(failures=failures):
                result, commands = self.run_script(
                    "install-ci-sdk.sh", fail_until=failures
                )
                self.assertEqual(result.returncode == 0, success, result.stderr)
                self.assertEqual(len(commands), expected_attempts)
                self.assertTrue(
                    all("ndk;28.2.13676358" in command for command in commands)
                )

    def test_requested_native_abis_build_with_locked_dependencies(self):
        result, commands = self.run_script("build-native.sh", "arm64-v8a", "x86_64")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(commands), 2)
        for command, target in zip(
            commands, ("aarch64-linux-android", "x86_64-linux-android")
        ):
            self.assertIn(f"--target {target} --release --locked", command)
        result, commands = self.run_script("build-native.sh", "unsupported")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(commands)


if __name__ == "__main__":
    unittest.main()
