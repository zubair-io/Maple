"""Commit attribution gate: tool identities and AI trailers never reach main."""

import os
import pathlib
import subprocess
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).with_name("check-commit-attribution.sh").resolve()
OWNER = ("Maple Owner", "owner@example.com")
TOOL = ("Claude", "noreply@anthropic.com")


class CommitAttributionTests(unittest.TestCase):
    def setUp(self):
        self.repo = tempfile.TemporaryDirectory()
        self.addCleanup(self.repo.cleanup)
        self.git("init", "-q", "-b", "main")
        self.commit("chore: base", OWNER)
        self.base = self.git("rev-parse", "HEAD")

    def git(self, *args, identity=OWNER):
        env = {
            **os.environ,
            "GIT_AUTHOR_NAME": identity[0],
            "GIT_AUTHOR_EMAIL": identity[1],
            "GIT_COMMITTER_NAME": OWNER[0],
            "GIT_COMMITTER_EMAIL": OWNER[1],
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_NOSYSTEM": "1",
        }
        return subprocess.run(
            ["git", *args],
            cwd=self.repo.name,
            env=env,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()

    def commit(self, message, identity):
        self.git(
            "commit",
            "-q",
            "--allow-empty",
            "--no-verify",
            "--no-gpg-sign",
            "-m",
            message,
            identity=identity,
        )

    def check(self, *args):
        return subprocess.run(
            ["bash", str(SCRIPT), *args],
            cwd=self.repo.name,
            capture_output=True,
            text=True,
        ).returncode

    def test_owner_commits_pass(self):
        self.commit("fix: owner work\n\nCo-Authored-By: Pat <pat@example.com>", OWNER)
        self.assertEqual(self.check(f"{self.base}..HEAD"), 0)

    def test_tool_author_fails(self):
        self.commit("fix: tool work", TOOL)
        self.assertEqual(self.check(f"{self.base}..HEAD"), 1)

    def test_ai_trailers_fail(self):
        for trailer in (
            "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>",
            "co-authored-by: Claude <claude@example.com>",
            "Claude-Session: https://claude.ai/code/session_x",
        ):
            with self.subTest(trailer=trailer):
                self.git("reset", "-q", "--hard", self.base)
                self.commit(f"fix: work\n\n{trailer}", OWNER)
                self.assertEqual(self.check(f"{self.base}..HEAD"), 1)

    def test_range_excludes_history(self):
        self.commit("fix: old\n\nClaude-Session: x", TOOL)
        tip = self.git("rev-parse", "HEAD")
        self.commit("fix: new", OWNER)
        self.assertEqual(self.check(f"{tip}..HEAD"), 0)

    def test_message_file(self):
        path = pathlib.Path(self.repo.name, "MSG")
        path.write_text(
            "fix: work\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n"
        )
        self.assertEqual(self.check("--message-file", str(path)), 1)
        path.write_text("fix: work\n\nRefs #1\n")
        self.assertEqual(self.check("--message-file", str(path)), 0)


if __name__ == "__main__":
    unittest.main()
