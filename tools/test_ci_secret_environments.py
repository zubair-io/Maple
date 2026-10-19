"""Signing and release credentials must live behind protected environments (#4751)."""

import re
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = ROOT / ".github/workflows"

SENSITIVE_ENVIRONMENTS = (
    (re.compile(r"^(VERSION_SYNC_TOKEN|AZURE_(CLIENT|TENANT|TS)_)"), "release"),
    (re.compile(r"^(MACOS_CERT_P12|APPSTORE_)"), "apple-signing"),
    (re.compile(r"^ANDROID_UPLOAD_"), "android-signing"),
)


def load(name):
    return yaml.safe_load((WORKFLOWS / f"{name}.yml").read_text())


def secret_names(value):
    return re.findall(r"secrets\.([A-Z0-9_]+)", str(value))


class SecretEnvironmentTests(unittest.TestCase):
    def test_owner_pat_fallback_is_gone(self):
        for path in WORKFLOWS.glob("*.yml"):
            with self.subTest(workflow=path.name):
                self.assertNotIn("JULES_GH", path.read_text())
                self.assertNotIn("secrets.MUSE", path.read_text())

    def test_sensitive_secrets_only_run_in_their_environment(self):
        for path in WORKFLOWS.glob("*.yml"):
            config = yaml.safe_load(path.read_text())
            for job_id, job in config.get("jobs", {}).items():
                names = secret_names(job)
                for pattern, environment in SENSITIVE_ENVIRONMENTS:
                    matched = [name for name in names if pattern.search(name)]
                    if matched:
                        with self.subTest(workflow=path.name, job=job_id, secrets=matched):
                            self.assertEqual(job.get("environment"), environment)

    def test_version_sync_uses_only_the_environment_scoped_token(self):
        job = load("version-sync")["jobs"]["create-release"]
        self.assertEqual(job.get("environment"), "release")
        self.assertEqual(job["env"]["GH_TOKEN"], "${{ secrets.VERSION_SYNC_TOKEN }}")
        checkout = next(
            step
            for step in job["steps"]
            if step.get("uses", "").startswith("actions/checkout@")
        )
        token = checkout["with"]["token"]
        self.assertEqual(token, "${{ secrets.VERSION_SYNC_TOKEN }}")

    def test_release_signing_uses_the_release_environment(self):
        jobs = load("release")["jobs"]
        self.assertEqual(jobs["windows-app"].get("environment"), "release")
        self.assertNotIn("environment", jobs["windows-build"])


if __name__ == "__main__":
    unittest.main()
