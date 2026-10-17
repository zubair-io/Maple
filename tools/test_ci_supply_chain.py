"""Privileged jobs must execute reviewed action and toolchain versions (#4752)."""

import re
import tomllib
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]


class SupplyChainTests(unittest.TestCase):
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
