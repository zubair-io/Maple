"""Build-wrapper contracts using fake tools; no native Windows qualification."""

import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("build-windows.sh")
X64 = "x86_64-pc-windows-msvc"
ARM64 = "aarch64-pc-windows-msvc"


class WindowsBuildContract(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="maple windows build ")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        # Isolate PATH so missing-tool cases cannot fall through to host tools.
        for tool in ("bash", "dirname", "mkdir"):
            executable = shutil.which(tool)
            self.assertIsNotNone(executable, tool)
            (self.bin / tool).symlink_to(executable)
        self.wrapper = self.root / "src/windows/scripts/build-windows.sh"
        self.wrapper.parent.mkdir(parents=True)
        shutil.copy2(SCRIPT, self.wrapper)
        self.env = {
            **os.environ,
            "PATH": str(self.bin),
            "BUILD_LOG": str(self.root / "calls.log"),
            "FAKE_HOST": X64,
        }
        for key in ("WINDOWS_TARGET", "FAIL_STAGE", "OMIT_OUTPUT"):
            self.env.pop(key, None)
        self.write_tool("rustc", 'printf "host: %s\\n" "$FAKE_HOST"')
        self.write_tool("git", "exit 0")
        self.write_tool("python3", "exit 0")
        self.write_tool(
            "cargo",
            """printf 'cargo' >> "$BUILD_LOG"
printf '|%s' "$@" >> "$BUILD_LOG"
printf '\\n' >> "$BUILD_LOG"
while (($#)); do
  case "$1" in
    --target) target="$2"; shift ;;
    --target-dir) target_dir="$2"; shift ;;
  esac
  shift
done
if [[ "$target_dir" == src/raw-pipeline/target ]]; then
  stage=ffi; output=raw_ffi.dll
else
  stage=host; output=maple-windows.exe
fi
[[ "${FAIL_STAGE:-}" == "$stage" ]] && exit 29
mkdir -p "$target_dir/$target/release"
[[ "${OMIT_OUTPUT:-}" == "$stage" ]] || printf binary > "$target_dir/$target/release/$output"
exit 0""",
        )
        self.write_tool(
            "dotnet",
            """printf 'dotnet' >> "$BUILD_LOG"
printf '|%s' "$@" >> "$BUILD_LOG"
printf '\\n' >> "$BUILD_LOG"
[[ "${FAIL_STAGE:-}" == dotnet ]] && exit 31
while (($#)); do
  if [[ "$1" == -o ]]; then output_dir="$2"; shift; fi
  shift
done
mkdir -p "$output_dir"
for output in Maple.WinUI.exe raw_ffi.dll; do
  [[ "${OMIT_OUTPUT:-}" == "$output" ]] || printf binary > "$output_dir/$output"
done
exit 0""",
        )
        codegen = self.root / "tools/codegen.sh"
        codegen.parent.mkdir()
        codegen.write_text(
            "#!/usr/bin/env bash\n"
            'printf "codegen|%s|%s\\n" "$CARGO_TARGET_DIR" '
            '"${CARGO_BUILD_TARGET:-unset}" >> "$BUILD_LOG"\n'
            '[[ "${FAIL_STAGE:-}" != codegen ]]\n'
        )
        codegen.chmod(0o755)

    def write_tool(self, name, body):
        path = self.bin / name
        path.write_text("#!/usr/bin/env bash\nset -eu\n" + body + "\n")
        path.chmod(0o755)

    def run_wrapper(self, **env):
        result = subprocess.run(
            [str(self.bin / "bash"), str(self.wrapper)],
            cwd=self.root,
            env={**self.env, **env},
            capture_output=True,
            text=True,
            check=False,
        )
        log = self.root / "calls.log"
        return result, log.read_text().splitlines() if log.exists() else []

    def assert_failed(self, result, message):
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertNotIn("built successfully", result.stdout)
        self.assertIn(message, result.stderr)

    def test_target_mapping_and_output_paths(self):
        for target, platform, rid in (
            (X64, "x64", "win-x64"),
            (ARM64, "ARM64", "win-arm64"),
        ):
            with self.subTest(target=target):
                result, calls = self.run_wrapper(
                    WINDOWS_TARGET=target,
                    FAKE_HOST=target,
                    CARGO_TARGET_DIR="unrelated/cache",
                    CARGO_BUILD_TARGET="wasm32-unknown-unknown",
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                run = calls[-4:]
                self.assertEqual(
                    run[0], f"codegen|{self.root}/src/raw-pipeline/target|unset"
                )
                self.assertIn(
                    f"|--target|{target}|--target-dir|src/raw-pipeline/target|", run[1]
                )
                self.assertIn(
                    f"|--target|{target}|--target-dir|src/windows/target|", run[2]
                )
                self.assertIn(
                    f"|-r|{rid}|-p:Platform={platform}|-p:MapleRustTarget={target}|",
                    run[3],
                )
                self.assertIn(
                    f"|-o|src/windows/Maple.WinUI/bin/Release/{target}", run[3]
                )
                self.assertIn(
                    f"src/windows/Maple.WinUI/bin/Release/{target}/Maple.WinUI.exe",
                    result.stdout,
                )

    def test_crlf_rust_host_is_accepted_without_relaxing_target_match(self):
        self.write_tool(
            "rustc",
            'printf "rustc 1.90.0\\r\\nhost: %s\\r\\nrelease: 1.90.0\\r\\n" "$FAKE_HOST"',
        )
        result, calls = self.run_wrapper()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"|--target|{X64}|", calls[1])
        (self.root / "calls.log").unlink()
        result, calls = self.run_wrapper(FAKE_HOST=ARM64)
        self.assert_failed(result, "cross-compilation is not supported")
        self.assertEqual(calls, [])

    def test_default_is_x64(self):
        result, calls = self.run_wrapper()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"|--target|{X64}|", calls[1])

    def test_unsupported_target_fails_before_build(self):
        result, calls = self.run_wrapper(WINDOWS_TARGET="x86_64-pc-windows-gnu")
        self.assert_failed(result, "unsupported WINDOWS_TARGET")
        self.assertEqual(calls, [])

    def test_cross_host_fails_before_build(self):
        for host in ("aarch64-apple-darwin", "x86_64-unknown-linux-gnu", ARM64):
            with self.subTest(host=host):
                result, calls = self.run_wrapper(FAKE_HOST=host)
                self.assert_failed(result, "cross-compilation is not supported")
                self.assertEqual(calls, [])

    def test_missing_dotnet_fails_before_build(self):
        (self.bin / "dotnet").unlink()
        result, calls = self.run_wrapper()
        self.assert_failed(result, "required tool 'dotnet'")
        self.assertEqual(calls, [])

    def test_build_failures_never_report_success(self):
        for stage in ("codegen", "ffi", "host", "dotnet"):
            with self.subTest(stage=stage):
                result, _ = self.run_wrapper(FAIL_STAGE=stage)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn("built successfully", result.stdout)

    def test_missing_outputs_fail(self):
        for output in ("ffi", "host", "Maple.WinUI.exe", "raw_ffi.dll"):
            with self.subTest(output=output):
                # Each case starts without stale outputs from a previous case.
                shutil.rmtree(self.root / "src/raw-pipeline/target", ignore_errors=True)
                shutil.rmtree(self.root / "src/windows/target", ignore_errors=True)
                shutil.rmtree(
                    self.root / "src/windows/Maple.WinUI/bin", ignore_errors=True
                )
                result, _ = self.run_wrapper(OMIT_OUTPUT=output)
                self.assert_failed(result, "missing")


class WindowsCodegenEncoding(unittest.TestCase):
    def test_agx_shader_is_utf8_without_locale_defaults(self):
        repo = SCRIPT.parents[3]
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / "agx_coeffs.wgsl"
            result = subprocess.run(
                [
                    sys.executable,
                    "-X",
                    "warn_default_encoding",
                    "-Werror::EncodingWarning",
                    str(repo / "src/scripts/derive_agx_lut.py"),
                    "--wgsl",
                    str(output),
                ],
                capture_output=True,
                check=False,
                env={**os.environ, "PYTHONUTF8": "0"},
            )
            self.assertEqual(
                result.returncode, 0, result.stderr.decode("utf-8", "replace")
            )
            shader = output.read_bytes()
            self.assertIn("—".encode(), shader)
            self.assertNotIn(b"\r\n", shader)
            self.assertEqual(
                shader,
                (
                    repo / "src/raw-pipeline/raw-gpu/src/generated/agx_coeffs.wgsl"
                ).read_bytes(),
            )


if __name__ == "__main__":
    unittest.main()
