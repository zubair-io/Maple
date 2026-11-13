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


RETIRED_SECRETS = {"JULES_GH", "MUSE"}
def expressions(text):
    found = []
    start = text.find("${{")
    while start != -1:
        index, quoted = start + 3, False
        while index < len(text):
            char = text[index]
            if char == "'":
                quoted = not quoted
            elif not quoted and text.startswith("}}", index):
                break
            index += 1
        found.append(text[start + 3 : index])
        start = text.find("${{", index)
    return found
INHERIT = re.compile(r"secrets:\s*inherit", re.IGNORECASE)
NAMED_SECRET = re.compile(r"secrets\s*(?:\.\s*([A-Za-z_]\w*)|\[\s*(['\"])([A-Za-z_]\w*)\2\s*\])", re.IGNORECASE)
WHOLE_OBJECT = re.compile(r"\bsecrets\b(?!\s*\.\s*[A-Za-z_]\w*)(?!\s*\[\s*(['\"])[A-Za-z_]\w*\1\s*\])", re.IGNORECASE)


def scalars(node):
    if isinstance(node, str):
        yield node
    elif isinstance(node, dict):
        for key, value in node.items():
            yield from scalars(key)
            yield from scalars(value)
    elif isinstance(node, (list, tuple)):
        for item in node:
            yield from scalars(item)


def workflow_files():
    return sorted(path for path in WORKFLOWS.iterdir() if path.suffix in (".yml", ".yaml"))


def load(name):
    return yaml.safe_load((WORKFLOWS / f"{name}.yml").read_text())


def secret_names(value):
    return [(dotted or quoted).upper() for dotted, _, quoted in NAMED_SECRET.findall(str(value))]


def job_secret_names(config, job):
    workflow_level = {key: value for key, value in config.items() if key != "jobs"}
    return secret_names(workflow_level) + secret_names(job)


class SecretEnvironmentTests(unittest.TestCase):
    def test_owner_pat_fallback_is_gone(self):
        for path in workflow_files():
            with self.subTest(workflow=path.name):
                decoded = list(scalars(yaml.safe_load(path.read_text())))
                self.assertFalse([value for value in decoded if "jules_gh" in value.lower()])
                names = {name for value in decoded for expression in expressions(value) for name in secret_names(expression)}
                self.assertFalse(names & RETIRED_SECRETS, names & RETIRED_SECRETS)

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

    def test_expression_scanner_ignores_braces_inside_quoted_strings(self):
        text = "x: ${{ format('{{{0}}}', secrets[format('{0}', 'VERSION_SYNC_TOKEN')]) }} y: ${{ secrets.OTHER }}"
        scanned = expressions(text)
        self.assertEqual(len(scanned), 2)
        self.assertIn("secrets[format(", scanned[0])
        self.assertIsNotNone(WHOLE_OBJECT.search(scanned[0]))

    def test_retired_names_are_found_after_yaml_escape_decoding(self):
        config = yaml.safe_load('TOKEN: "${{ secrets.M\\u0055SE }}"\n')
        names = {name for value in scalars(config) for expression in expressions(value) for name in secret_names(expression)}
        self.assertIn("MUSE", names)

    def test_retired_secrets_are_found_in_every_access_form(self):
        for expression in ("secrets.MUSE", "secrets['MUSE']", "secrets . muse", "secrets [ \"Jules_GH\" ]"):
            with self.subTest(expression=expression):
                self.assertTrue(set(secret_names(expression)) & RETIRED_SECRETS)

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
            config = yaml.safe_load(text)
            with self.subTest(workflow=path.name):
                self.assertIsNone(INHERIT.search(text))
                for value in scalars(config):
                    for expression in expressions(value):
                        self.assertIsNone(WHOLE_OBJECT.search(expression), expression)

    def test_yaml_escapes_are_decoded_before_scanning(self):
        config = yaml.safe_load('ALL: "${{ toJSON(secr\\u0065ts) }}"\n')
        found = [expression for value in scalars(config) for expression in expressions(value)]
        self.assertEqual(len(found), 1)
        self.assertIsNotNone(WHOLE_OBJECT.search(found[0]))

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
            " secrets['harmless' && 'VERSION_SYNC_TOKEN'] ",
            " secrets['VERSION_SYNC_TOKEN' || 'x'] ",
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
