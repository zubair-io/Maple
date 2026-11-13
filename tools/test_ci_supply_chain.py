"""Privileged jobs must execute reviewed action and toolchain versions (#4752)."""

import re
import tomllib
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
# Verified in dtolnay/rust-toolchain master history with GitHub's compare API.
RUST_TOOLCHAIN_MASTER_SHA = "683b588c487a69d01f6c6ddf40f036ff682cc2c8"


class SupplyChainTests(unittest.TestCase):
    def test_hosted_wasm_pack_version_is_published_release_tag(self):
        config = yaml.safe_load(
            (ROOT / ".github/workflows/deploy-hosted.yml").read_text()
        )
        steps = config["jobs"]["build-and-deploy"]["steps"]
        action = next(
            step for step in steps if step.get("uses", "").startswith("jetli/wasm-pack-action@")
        )
        self.assertEqual(action["with"]["version"], "v0.15.0")

    def test_privileged_rust_action_uses_retained_pin_and_explicit_toolchain(self):
        native = tomllib.loads(
            (ROOT / "src/raw-pipeline/rust-toolchain.toml").read_text()
        )["toolchain"]["channel"]
        wasm = tomllib.loads(
            (ROOT / "src/raw-pipeline/raw-wasm/rust-toolchain.toml").read_text()
        )["toolchain"]["channel"]
        expected = {
            "android-distribution": (1, native),
            "release": (1, native),
            "publish-package": (3, native),
            "deploy-hosted": (1, wasm),
        }
        for name, (count, toolchain) in expected.items():
            config = yaml.safe_load(
                (ROOT / f".github/workflows/{name}.yml").read_text()
            )
            steps = (
                step for job in config["jobs"].values() for step in job.get("steps", [])
            )
            rust_steps = [
                step
                for step in steps
                if step.get("uses", "").startswith("dtolnay/rust-toolchain@")
            ]
            self.assertEqual(len(rust_steps), count, name)
            for step in rust_steps:
                with self.subTest(workflow=name, step=step.get("name")):
                    self.assertEqual(
                        step["uses"],
                        f"dtolnay/rust-toolchain@{RUST_TOOLCHAIN_MASTER_SHA}",
                    )
                    self.assertEqual(step["with"]["toolchain"], toolchain)

    def test_privileged_workflow_actions_are_immutable(self):
        for path in (ROOT / ".github/workflows").glob("*.yml"):
            config = yaml.safe_load(path.read_text())
            privileged = path.stem == "publish-package" or any(
                "secrets." in str(job)
                or job.get("secrets")
                or "write" in str(job.get("permissions", config.get("permissions", {})))
                for job in config.get("jobs", {}).values()
            )
            if not privileged:
                continue
            for line in path.read_text().splitlines():
                match = re.match(r"\s*(?:- )?uses: ([^\s]+)(.*)", line)
                if match and not match[1].startswith("./"):
                    with self.subTest(path=path.name, action=match[1]):
                        self.assertRegex(match[1], r"@[0-9a-f]{40}$")
                        self.assertRegex(match[2], r"\s+# \S+")

    def test_native_toolchain_and_docker_builders_agree(self):
        toolchain = tomllib.loads(
            (ROOT / "src/raw-pipeline/rust-toolchain.toml").read_text()
        )["toolchain"]["channel"]
        self.assertRegex(toolchain, r"^\d+\.\d+\.\d+$")
        for name in ("release", "android-distribution", "publish-package"):
            config = yaml.safe_load(
                (ROOT / f".github/workflows/{name}.yml").read_text()
            )
            for job in config["jobs"].values():
                for step in job.get("steps", []):
                    if step.get("uses", "").startswith("dtolnay/rust-toolchain@"):
                        self.assertEqual(step["with"]["toolchain"], toolchain)
        docker = (ROOT / "src/api/Dockerfile").read_text()
        versions = re.findall(r"FROM rust:([^ ]+)", docker)
        self.assertEqual(versions, [f"{toolchain}-slim-bookworm"] * 2)
        self.assertRegex(
            docker, r"cargo install wasm-pack --version \d+\.\d+\.\d+ --locked"
        )
        self.assertNotIn("installer/init.sh", docker)
        wasm = tomllib.loads(
            (ROOT / "src/raw-pipeline/raw-wasm/rust-toolchain.toml").read_text()
        )["toolchain"]
        self.assertRegex(wasm["channel"], r"^nightly-\d{4}-\d{2}-\d{2}$")
        self.assertIn("rust-src", wasm["components"])
        self.assertIn("wasm32-unknown-unknown", wasm["targets"])

    def test_zigbuild_installs_its_pinned_dependency_metadata(self):
        config = yaml.safe_load(
            (ROOT / ".github/workflows/publish-package.yml").read_text()
        )
        steps = config["jobs"]["build-linux"]["steps"]
        zig = next(
            step["with"]["version"]
            for step in steps
            if step.get("name") == "Install Zig"
        )
        install = next(
            step["run"]
            for step in steps
            if step.get("name") == "Install cargo-zigbuild"
        )
        self.assertNotIn("--no-deps", install)
        self.assertIn(f"ziglang=={zig}", install)
        self.assertIn("--constraint", install)

    def test_privileged_build_tools_are_exact_versions(self):
        package = (ROOT / ".github/workflows/publish-package.yml").read_text()
        self.assertRegex(package, r"pipx install cargo-zigbuild==\d+\.\d+\.\d+")
        release = (ROOT / ".github/workflows/release.yml").read_text()
        self.assertRegex(release, r"choco install innosetup --version=\d+\.\d+\.\d+")
        for name in ("publish-package", "version-sync", "deploy-hosted"):
            text = (ROOT / f".github/workflows/{name}.yml").read_text()
            self.assertNotIn("bun-version: latest", text)
            self.assertRegex(text, r"bun-version: \d+\.\d+\.\d+")
        for name in (
            "release",
            "android-distribution",
            "publish-package",
            "deploy-drive-connect",
        ):
            config = yaml.safe_load(
                (ROOT / f".github/workflows/{name}.yml").read_text()
            )
            for job in config["jobs"].values():
                for step in job.get("steps", []):
                    for key, value in step.get("with", {}).items():
                        if key in (
                            "dotnet-version",
                            "java-version",
                            "python-version",
                            "node-version",
                        ):
                            self.assertRegex(str(value), r"^\d+\.\d+\.\d+(?:[.+]\d+)*$")
        config = yaml.safe_load((ROOT / ".github/dependabot.yml").read_text())
        self.assertTrue(
            any(
                row["package-ecosystem"] == "github-actions"
                for row in config["updates"]
            )
        )


if __name__ == "__main__":
    unittest.main()
