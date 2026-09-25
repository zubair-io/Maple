"""Exercise handoff policy against real Git objects in disposable repositories."""

import copy
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import release_control as control
import release_handoff as policy


class GitFixture(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.previous = os.getcwd()
        self.addCleanup(os.chdir, self.previous)
        os.chdir(self.directory.name)
        self.git("init", "--bare", "remote.git")
        self.git("init", "-b", "main", "work")
        os.chdir("work")
        self.git("config", "user.name", "Release test")
        self.git("config", "user.email", "release@example.test")
        self.git("remote", "add", "origin", "../remote.git")
        self.write(
            policy.PACKAGE,
            json.dumps(
                {
                    "name": "@justmaple/maple",
                    "version": "1.2.3",
                    "optionalDependencies": {"@justmaple/maple-test": "1.2.3"},
                },
                indent=2,
            )
            + "\n",
        )
        self.write(
            "src/maple/npm/test/package.json",
            json.dumps({"name": "@justmaple/maple-test", "version": "1.2.3"}, indent=2)
            + "\n",
        )
        self.write(
            policy.APPLE, "MARKETING_VERSION = 1.2.3;\nMARKETING_VERSION = 1.2.3;\n"
        )
        self.write(
            "src/maple/src/version.ts", "export const MAPLE_VERSION = '1.2.3';\n"
        )
        self.write(
            "src/maple/dist/index.js",
            'var MAPLE_VERSION = "1.2.3";\nconst unrelated = 42;\n',
        )
        self.write(
            "src/maple/dist/version.d.ts",
            'export declare const MAPLE_VERSION = "1.2.3";\n',
        )
        self.main = self.commit("Initial release fixture")
        self.git("push", "origin", "main")
        self.prs = []
        self.statuses = []
        self.api_patch = patch.object(control, "api", side_effect=self.api)
        self.api_patch.start()
        self.addCleanup(self.api_patch.stop)
        self.pr_patch = patch.object(
            control, "open_prs", side_effect=lambda _: copy.deepcopy(self.prs)
        )
        self.pr_patch.start()
        self.addCleanup(self.pr_patch.stop)

    def git(self, *args):
        return subprocess.check_output(
            ["git", *args], text=True, stderr=subprocess.DEVNULL
        ).strip()

    def write(self, path, value):
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(value)

    def commit(self, message):
        self.git("add", ".")
        self.git("commit", "-m", message)
        return self.git("rev-parse", "HEAD")

    def bump(self, new="1.2.4"):
        for path, value in policy.expected_files(self.main, new).items():
            self.write(path, value)
        return self.commit(f"Start {new}")

    def handoff(self, tagged=True):
        head = self.bump()
        self.git("push", "origin", f"{head}:refs/heads/{policy.branch('1.2.3')}")
        if tagged:
            self.git("tag", "-a", "v1.2.3", self.main, "-m", "Release")
            self.git("push", "origin", "refs/tags/v1.2.3")
        return head

    def pr(self, sha, name="feature", repo="owner/repo"):
        return {
            "head": {"sha": sha, "ref": name, "repo": {"full_name": repo}},
            "html_url": "https://example.test/pr/1",
        }

    def api(self, repo, endpoint, payload=None):
        if endpoint.startswith("statuses/"):
            self.statuses.append((endpoint.split("/")[1], payload))
            return {}
        if endpoint == "git/ref/heads/main":
            return {"object": {"sha": self.git("rev-parse", "origin/main")}}
        if endpoint == "rules/branches/main":
            return [
                {
                    "type": "required_status_checks",
                    "parameters": {
                        "required_status_checks": [{"context": policy.CONTEXT}]
                    },
                }
            ]
        raise AssertionError(endpoint)


class VersionTests(GitFixture):
    def test_default_and_explicit_next_version(self):
        self.assertEqual(policy.next_version("1.2.9"), "1.2.10")
        self.assertEqual(policy.next_version("1.2.9", "v2.0.0"), "2.0.0")
        for value in ["1.2.9", "1.0.0", "1.3.0-beta", "01.3.0", "oops"]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                policy.next_version("1.2.9", value)

    def test_complete_version_only_bump(self):
        policy.validate_versions(self.main)
        policy.validate_bump(self.main, self.bump())

    def test_inconsistent_apple_version_rejected(self):
        self.write(policy.APPLE, "MARKETING_VERSION = 1.2.2;\n")
        with self.assertRaises(ValueError):
            policy.validate_versions(self.commit("Broken Apple version"))

    def test_missing_source_constant_rejected(self):
        self.write("src/maple/src/version.ts", "export const OTHER = '1.2.3';\n")
        with self.assertRaises(ValueError):
            policy.validate_versions(self.commit("Missing constant"))

    def test_unrelated_file_rejected(self):
        self.bump()
        self.write("unexpected.txt", "Do not ship this\n")
        with self.assertRaises(ValueError):
            policy.validate_bump(self.main, self.commit("Extra file"))

    def test_smuggled_bundle_code_rejected(self):
        self.bump()
        with Path("src/maple/dist/index.js").open("a") as output:
            output.write("stealToken();\n")
        with self.assertRaises(ValueError):
            policy.validate_bump(self.main, self.commit("Extra executable code"))

    def test_file_mode_change_rejected(self):
        self.bump()
        Path("src/maple/src/version.ts").chmod(0o755)
        with self.assertRaises(ValueError):
            policy.validate_bump(self.main, self.commit("Mode change"))

    def test_incomplete_bump_rejected(self):
        self.bump()
        self.write(policy.APPLE, policy.blob(self.main, policy.APPLE))
        with self.assertRaises(ValueError):
            policy.validate_bump(self.main, self.commit("Missing Apple bump"))


class GateTests(GitFixture):
    def test_no_handoff_all_prs_pass_including_forks(self):
        self.prs = [self.pr(self.main), self.pr(self.main, repo="fork/repo")]
        control.refresh_gate("owner/repo")
        self.assertEqual([p["state"] for _, p in self.statuses], ["success"])

    def test_before_tag_all_prs_blocked(self):
        head = self.handoff(tagged=False)
        self.prs = [self.pr(head, policy.branch("1.2.3")), self.pr(self.main)]
        control.refresh_gate("owner/repo")
        self.assertEqual([p["state"] for _, p in self.statuses], ["pending", "pending"])

    def test_only_exact_bump_head_passes_after_tag(self):
        head = self.handoff()
        self.prs = [
            self.pr(head, policy.branch("1.2.3")),
            self.pr(self.main),
            self.pr("a" * 40, policy.branch("1.2.3"), "fork/repo"),
        ]
        control.refresh_gate("owner/repo")
        self.assertEqual(
            [p["state"] for _, p in self.statuses], ["success", "pending", "pending"]
        )

    def test_same_sha_fork_cannot_veto_validated_bump_status(self):
        # The identical Git commit carries the same validated version-only tree.
        head = self.handoff()
        self.prs = [
            self.pr(head, policy.branch("1.2.3"), "fork/repo"),
            self.pr(head, policy.branch("1.2.3")),
        ]
        control.refresh_gate("owner/repo")
        self.assertEqual(self.statuses[-1][1]["state"], "success")

    def test_local_only_tag_cannot_unblock_bump(self):
        head = self.handoff(tagged=False)
        self.git("tag", "v1.2.3", self.main)
        self.prs = [self.pr(head, policy.branch("1.2.3"))]
        control.refresh_gate("owner/repo")
        self.assertEqual(self.statuses[-1][1]["state"], "pending")

    def test_changed_bump_head_is_blocked(self):
        self.handoff()
        self.write("extra.txt", "extra\n")
        changed = self.commit("Unexpected edit")
        self.prs = [self.pr(changed, policy.branch("1.2.3"))]
        control.refresh_gate("owner/repo")
        self.assertEqual(self.statuses[-1][1]["state"], "pending")

    def test_main_bump_unblocks_without_next_tag(self):
        head = self.handoff()
        self.prs = [self.pr(self.main)]
        control.refresh_gate("owner/repo")
        self.assertEqual(self.statuses[-1][1]["state"], "pending")
        self.git("push", "origin", f"{head}:refs/heads/main")
        control.refresh_gate("owner/repo")
        self.assertEqual(self.statuses[-1][1]["state"], "success")
        self.assertFalse(control.ref_exists("refs/tags/v1.2.4"))

    def test_main_movement_blocks_stale_bump(self):
        head = self.handoff()
        self.git("checkout", "--detach", self.main)
        self.write("new.txt", "Another merge\n")
        moved = self.commit("Main moved")
        self.git("push", "origin", f"{moved}:refs/heads/main")
        self.prs = [self.pr(head, policy.branch("1.2.3"))]
        control.refresh_gate("owner/repo")
        self.assertEqual(self.statuses[-1][1]["state"], "pending")

    def test_tag_alone_fails_closed(self):
        self.git("tag", "v1.2.3", self.main)
        self.git("push", "origin", "refs/tags/v1.2.3")
        self.prs = [self.pr(self.main)]
        control.refresh_gate("owner/repo")
        self.assertEqual(self.statuses[-1][1]["state"], "pending")


if __name__ == "__main__":
    unittest.main()
