"""Focused web CI contracts. Run with python3 -m unittest tools/test_ci_web.py."""

import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
JOBS = yaml.safe_load((ROOT / ".github/workflows/web.yml").read_text())["jobs"]
CONSUMERS = ("web-build", "web-test", "web-test-common", "web-webgpu-smoke")


def step(job, name):
    return next(s for s in JOBS[job]["steps"] if s.get("name") == name)


class WebWorkflowTests(unittest.TestCase):
    def test_only_producer_provisions_wasm_and_artifact_is_same_run(self):
        for action in ("dtolnay/rust-toolchain@", "jetli/wasm-pack-action@"):
            owners = [
                job
                for job, config in JOBS.items()
                for item in config.get("steps", [])
                if item.get("uses", "").startswith(action)
            ]
            self.assertEqual(owners, ["build-wasm"])
        upload = step("build-wasm", "Upload raw-wasm package")["with"]
        self.assertEqual(upload["path"], "src/raw-pipeline/raw-wasm/pkg/")
        self.assertEqual(upload["if-no-files-found"], "error")
        for job in CONSUMERS:
            needs = JOBS[job]["needs"]
            self.assertIn("build-wasm", [needs] if isinstance(needs, str) else needs)
            download = step(job, "Download raw-wasm package")["with"]
            self.assertEqual(download, {"name": upload["name"], "path": upload["path"]})
            self.assertFalse(
                any("run raw-wasm" in s.get("run", "") for s in JOBS[job]["steps"])
            )

    def test_fixture_probe_handles_both_paths_before_provisioning(self):
        steps = JOBS["web-webgpu-smoke"]["steps"]
        probe = step("web-webgpu-smoke", "Probe smoke RAW fixture")
        self.assertEqual(steps.index(probe), 1)
        for item in steps[2:]:
            self.assertIn("steps.fixture.outputs.available == 'true'", item["if"])
        for present in (False, True):
            with self.subTest(present=present), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                if present:
                    fixture = root / "test-fixtures/raws/test_0006.DNG"
                    fixture.parent.mkdir(parents=True)
                    fixture.touch()
                output, summary = root / "output", root / "summary"
                subprocess.run(
                    ["bash", "-e", "-c", probe["run"]],
                    cwd=root,
                    env={
                        **os.environ,
                        "GITHUB_OUTPUT": str(output),
                        "GITHUB_STEP_SUMMARY": str(summary),
                    },
                    check=True,
                    capture_output=True,
                    text=True,
                )
                self.assertEqual(
                    output.read_text().strip(), f"available={str(present).lower()}"
                )
                if not present:
                    self.assertIn("skipped", summary.read_text())

    def test_download_stamp_prevents_lifecycle_recompilation(self):
        # Model the consumer checkout having newer mtimes than producer output.
        # Run the actual build wrapper twice, as nested prebuild hooks do.
        for job in CONSUMERS:
            with self.subTest(job=job), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                crate = root / "src/raw-pipeline/raw-wasm"
                pkg = crate / "pkg"
                pkg.mkdir(parents=True)
                for name in ("raw_wasm_bg.wasm", "raw_wasm.js", ".build-stamp"):
                    artifact = pkg / name
                    artifact.write_text("test artifact")
                    os.utime(artifact, (1, 1))
                (crate / "lib.rs").touch()
                shutil.copyfile(
                    ROOT / "src/raw-pipeline/raw-wasm/build.sh", crate / "build.sh"
                )
                prepare = step(job, "Sync raw-wasm package without compiling")["run"]
                validation_and_stamp, sync = prepare.split(
                    "bash src/web/scripts/sync-raw-wasm.sh"
                )
                self.assertFalse(sync.strip())
                subprocess.run(
                    ["bash", "-e", "-c", validation_and_stamp], cwd=root, check=True
                )
                for _ in range(2):
                    result = subprocess.run(
                        ["bash", str(crate / "build.sh")],
                        env={**os.environ, "FORCE_WASM_REBUILD": "0"},
                        check=True,
                        capture_output=True,
                        text=True,
                    )
                    self.assertIn("No source changes since last build", result.stdout)


if __name__ == "__main__":
    unittest.main()
