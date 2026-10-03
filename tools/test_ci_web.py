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
CONSUMERS = (
    "web-build",
    "web-test",
    "web-test-common",
    "web-webgpu-smoke",
    "web-workflow-acceptance",
)


def step(job, name):
    return next(s for s in JOBS[job]["steps"] if s.get("name") == name)


def validate_rust_provisioning(jobs):
    actual = [
        (job, item["uses"])
        for job, config in jobs.items()
        for item in config.get("steps", [])
        if item.get("uses", "").startswith("dtolnay/rust-toolchain@")
    ]
    expected = {
        ("build-wasm", "dtolnay/rust-toolchain@nightly"),
        ("web-workflow-acceptance", "dtolnay/rust-toolchain@stable"),
    }
    if len(actual) != len(expected) or set(actual) != expected:
        raise ValueError(
            f"Unexpected Rust provisioning (stable is only for native FFI): {actual}"
        )


class WebWorkflowTests(unittest.TestCase):
    def test_only_producer_provisions_wasm_and_artifact_is_same_run(self):
        validate_rust_provisioning(JOBS)
        for action in ("jetli/wasm-pack-action@",):
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

    def test_accidental_stable_or_nightly_wasm_consumer_is_rejected(self):
        import copy

        for job, action in (
            ("web-test", "dtolnay/rust-toolchain@stable"),
            ("web-build", "dtolnay/rust-toolchain@nightly"),
            ("build-wasm", "dtolnay/rust-toolchain@stable"),
        ):
            jobs = copy.deepcopy(JOBS)
            if job == "build-wasm":
                item = next(
                    item
                    for item in jobs[job]["steps"]
                    if item.get("uses", "").startswith("dtolnay/rust-toolchain@")
                )
                item["uses"] = action
            else:
                jobs[job]["steps"].append({"uses": action})
            with self.subTest(job=job, action=action), self.assertRaises(ValueError):
                validate_rust_provisioning(jobs)

    def test_repeated_cycles_preserve_the_separate_mode_report_and_gate_evidence(self):
        steps = JOBS["web-workflow-acceptance"]["steps"]
        modes = step("web-workflow-acceptance", "Qualify white balance and Auto Tone")
        preserve = step(
            "web-workflow-acceptance", "Preserve white balance and Auto Tone report"
        )
        cycles = step(
            "web-workflow-acceptance",
            "Qualify 100 repeated cycles on each Web deployment",
        )
        self.assertLess(steps.index(modes), steps.index(preserve))
        self.assertLess(steps.index(preserve), steps.index(cycles))
        self.assertIn("stats['expected'] == 24", modes["run"])
        self.assertIn("wb-auto-tone-results.json", preserve["run"])
        self.assertIn("repeated-workflow.spec.ts", cycles["run"])
        self.assertIn(
            "check_web_cycle_evidence.py test-results/workflow/results.json",
            cycles["run"],
        )
        restored = step(
            "web-workflow-acceptance", "Restore white balance and Auto Tone report"
        )
        self.assertIn("$RUNNER_TEMP/wb-auto-tone-results.json", preserve["run"])
        self.assertLess(steps.index(cycles), steps.index(restored))
        self.assertIn("always()", restored["if"])
        self.assertIn("wb-auto-tone-results.json", restored["run"])
        self.assertNotIn("continue-on-error", cycles)
        self.assertIn("web-workflow-acceptance", JOBS["result"]["needs"])

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
