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


EXPRESSION = re.compile(r"\$\{\{(.*?)\}\}", re.DOTALL)
INHERIT = re.compile(r"secrets:\s*inherit", re.IGNORECASE)
WHOLE_OBJECT = re.compile(r"\bsecrets\b(?!\s*\.\s*[A-Za-z_])(?!\s*\[\s*['\"])", re.IGNORECASE)


def workflow_files():
    return sorted(path for path in WORKFLOWS.iterdir() if path.suffix in (".yml", ".yaml"))


def load(name):
    return yaml.safe_load((WORKFLOWS / f"{name}.yml").read_text())


def secret_names(value):
    found = re.findall(r"secrets\s*(?:\.\s*|\[\s*['\"])([A-Za-z0-9_]+)", str(value), re.IGNORECASE)
    return [name.upper() for name in found]


def job_secret_names(config, job):
    workflow_level = {key: value for key, value in config.items() if key != "jobs"}
    return secret_names(workflow_level) + secret_names(job)


class SecretEnvironmentTests(unittest.TestCase):
    def test_owner_pat_fallback_is_gone(self):
        for path in workflow_files():
            with self.subTest(workflow=path.name):
                text = path.read_text().lower()
                self.assertNotIn("jules_gh", text)
                self.assertNotIn("secrets.muse", text)

    def test_sensitive_secrets_only_run_in_their_environment(self):
        for path in workflow_files():
            config = yaml.safe_load(path.read_text())
            for job_id, job in config.get("jobs", {}).items():
                names = job_secret_names(config, job)
                for pattern, environment in SENSITIVE_ENVIRONMENTS:
                    matched = [name for name in names if pattern.search(name)]
                    if matched:
                        with self.subTest(workflow=path.name, job=job_id, secrets=matched):
                            self.assertEqual(job.get("environment"), environment)

    def test_secret_names_recognises_property_and_index_access(self):
        self.assertEqual(secret_names("${{ secrets.VERSION_SYNC_TOKEN }}"), ["VERSION_SYNC_TOKEN"])
        self.assertEqual(secret_names("${{ secrets['VERSION_SYNC_TOKEN'] }}"), ["VERSION_SYNC_TOKEN"])
        self.assertEqual(secret_names('${{ secrets[ "ANDROID_UPLOAD_KEY" ] }}'), ["ANDROID_UPLOAD_KEY"])

    def test_secret_names_allow_whitespace_around_access_operators(self):
        for expression in (
            "${{ secrets ['VERSION_SYNC_TOKEN'] }}",
            "${{ secrets . VERSION_SYNC_TOKEN }}",
            "${{ secrets\n  .VERSION_SYNC_TOKEN }}",
            "${{ secrets [ \"VERSION_SYNC_TOKEN\" ] }}",
        ):
            with self.subTest(expression=expression):
                self.assertEqual(secret_names(expression), ["VERSION_SYNC_TOKEN"])

    def test_secret_names_ignore_case_and_include_workflow_level_values(self):
        self.assertEqual(secret_names("${{ secrets.version_sync_token }}"), ["VERSION_SYNC_TOKEN"])
        config = {"env": {"TOKEN": "${{ secrets.VERSION_SYNC_TOKEN }}"}, "jobs": {"build": {"steps": []}}}
        self.assertEqual(job_secret_names(config, config["jobs"]["build"]), ["VERSION_SYNC_TOKEN"])

    def test_no_workflow_hands_over_the_whole_secrets_object(self):
        for path in workflow_files():
            text = path.read_text()
            with self.subTest(workflow=path.name):
                self.assertIsNone(INHERIT.search(text))
                for expression in EXPRESSION.findall(text):
                    self.assertIsNone(WHOLE_OBJECT.search(expression), expression)

    def test_no_parsed_job_inherits_all_secrets(self):
        for path in workflow_files():
            config = yaml.safe_load(path.read_text())
            for job_id, job in config.get("jobs", {}).items():
                with self.subTest(workflow=path.name, job=job_id):
                    self.assertNotEqual(str(job.get("secrets", "")).strip().lower(), "inherit")

    def test_aliased_inherit_is_caught_after_parsing(self):
        config = yaml.safe_load("x: &all inherit\njobs:\n  call:\n    secrets: *all\n")
        self.assertEqual(str(config["jobs"]["call"]["secrets"]).lower(), "inherit")

    def test_whole_object_patterns_catch_equivalent_spellings(self):
        for expression in (
            " toJSON(secrets) ",
            " toJSON ( secrets ) ",
            " format('{0}', secrets) ",
            " secrets[format('{0}', 'X')] ",
        ):
            with self.subTest(expression=expression):
                self.assertIsNotNone(WHOLE_OBJECT.search(expression))
        self.assertIsNotNone(WHOLE_OBJECT.search(" toJSON(secrets.*) "))
        self.assertIsNotNone(WHOLE_OBJECT.search(" toJSON(secrets . *) "))
        self.assertIsNone(WHOLE_OBJECT.search(" secrets.VERSION_SYNC_TOKEN "))
        self.assertIsNone(WHOLE_OBJECT.search(" secrets ['VERSION_SYNC_TOKEN'] "))

    def test_workflow_files_cover_yaml_and_yml(self):
        self.assertTrue(all(path.suffix in (".yml", ".yaml") for path in workflow_files()))
        self.assertIn("release.yml", [path.name for path in workflow_files()])

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
