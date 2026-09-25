"""Release orchestration smoke tests: real local remote, fake GitHub/build transport."""

import copy
import json
import os
import subprocess
from pathlib import Path
from unittest.mock import patch

import release_control as control
import release_handoff as policy
from test_release_handoff import GitFixture


class ReleaseTests(GitFixture):
    def setUp(self):
        super().setUp()
        self.calls = []
        self.fail_pr = False
        self.issues = []
        real_run = control.run

        def live_prs(_):
            result = copy.deepcopy(self.prs)
            for pr in result:
                ref = f"refs/remotes/origin/{pr['head']['ref']}"
                if control.ref_exists(ref):
                    pr["head"]["sha"] = self.git("rev-parse", ref)
            return result

        control.open_prs.side_effect = live_prs

        def transport(*args, **kwargs):
            self.calls.append(args)
            if args[:2] == ("bash", "tools/sync-release-version.sh"):
                for path, text in policy.expected_files(self.main, args[2]).items():
                    self.write(path, text)
                return ""
            if args[0] == "bun":
                return ""
            if args[:3] == ("gh", "issue", "list"):
                return json.dumps(self.issues)
            if args[:3] == ("gh", "issue", "create"):
                self.issues.append(
                    {"number": 42, "title": args[args.index("--title") + 1]}
                )
                return "https://example.test/issues/42"
            if args[:3] == ("gh", "issue", "edit"):
                return ""
            if args[:3] == ("gh", "pr", "create"):
                if self.fail_pr:
                    raise subprocess.CalledProcessError(1, args)
                body = Path(args[args.index("--body-file") + 1]).read_text()
                self.assertIn("Closes #42", body)
                self.prs.append(
                    self.pr(self.git("rev-parse", "HEAD"), policy.branch("1.2.3"))
                )
                return self.prs[-1]["html_url"]
            return real_run(*args, **kwargs)

        self.transport = patch.object(control, "run", side_effect=transport)
        self.transport.start()
        self.addCleanup(self.transport.stop)
        self.green = patch.object(control, "require_green_main")
        self.green.start()
        self.addCleanup(self.green.stop)
        self.validated = patch.object(control, "require_release_validation")
        self.validated.start()
        self.addCleanup(self.validated.stop)

    def test_missing_validation_aborts_before_remote_writes(self):
        self.validated.stop()
        with (
            patch.dict(os.environ, {}, clear=True),
            self.assertRaisesRegex(ValueError, "VALIDATED_APPLE_SHA"),
        ):
            control.release("owner/repo", "")
        self.assertEqual(self.issues, [])
        self.assertEqual(self.prs, [])
        self.assertEqual(self.statuses, [])
        self.assertFalse(any(args[:2] == ("git", "push") for args in self.calls))
        self.assertIsNone(control.remote_tag("v1.2.3"))

    def test_release_tags_current_commit_then_opens_bump(self):
        control.release("owner/repo", "")
        self.assertEqual(self.git("rev-parse", "v1.2.3^{commit}"), self.main)
        self.assertEqual(policy.version("origin/main"), "1.2.3")
        self.assertEqual(policy.version(self.prs[0]["head"]["sha"]), "1.2.4")
        pushes = [
            i
            for i, args in enumerate(self.calls)
            if args[:2] == ("git", "push") and args[-1] == "refs/tags/v1.2.3"
        ]
        create = next(
            i for i, args in enumerate(self.calls) if args[:3] == ("gh", "pr", "create")
        )
        self.assertLess(pushes[0], create)
        self.assertEqual(self.statuses[-1][1]["state"], "success")

    def test_retry_reuses_tag_branch_and_pr(self):
        control.release("owner/repo", "2.0.0")
        tag = self.git("rev-parse", "v1.2.3")
        head = self.prs[0]["head"]["sha"]
        control.release("owner/repo", "")
        self.assertEqual(self.git("rev-parse", "v1.2.3"), tag)
        self.assertEqual(self.prs[0]["head"]["sha"], head)
        self.assertEqual(len(self.prs), 1)
        self.assertEqual(len(self.issues), 1)

    def test_failed_pr_creation_keeps_other_prs_blocked_and_retry_recovers(self):
        self.prs = [self.pr(self.main)]
        self.fail_pr = True
        with self.assertRaises(subprocess.CalledProcessError):
            control.release("owner/repo", "")
        self.assertEqual(self.statuses[-1][1]["state"], "pending")
        tag = self.git("rev-parse", "v1.2.3")
        self.fail_pr = False
        control.release("owner/repo", "")
        self.assertEqual(self.git("rev-parse", "v1.2.3"), tag)
        self.assertEqual(len(self.prs), 2)

    def test_refuses_next_version_change_on_retry(self):
        control.release("owner/repo", "")
        with self.assertRaisesRegex(ValueError, "Retry"):
            control.release("owner/repo", "3.0.0")

    def test_requires_gate_before_remote_writes(self):
        with (
            patch.object(control, "api", return_value=[]),
            self.assertRaisesRegex(ValueError, "Require"),
        ):
            control.release("owner/repo", "")
        self.assertFalse(any(args[:2] == ("git", "push") for args in self.calls))

    def test_red_main_prevents_tag_and_branch_push(self):
        with (
            patch.object(
                control, "require_green_main", side_effect=ValueError("red CI")
            ),
            self.assertRaisesRegex(ValueError, "red CI"),
        ):
            control.release("owner/repo", "")
        self.assertFalse(any(args[:2] == ("git", "push") for args in self.calls))

    def test_project_access_failure_prevents_release_side_effects(self):
        with (
            patch.object(
                control,
                "handoff_issue",
                side_effect=RuntimeError("Project access missing"),
            ),
            self.assertRaises(RuntimeError),
        ):
            control.release("owner/repo", "")
        self.assertFalse(any(args[:2] == ("git", "push") for args in self.calls))

    def test_main_race_aborts_without_tag(self):
        real_api = self.api

        def moved(repo, endpoint, payload=None):
            if endpoint == "git/ref/heads/main":
                return {"object": {"sha": "a" * 40}}
            return real_api(repo, endpoint, payload)

        with (
            patch.object(control, "api", side_effect=moved),
            self.assertRaisesRegex(ValueError, "main moved"),
        ):
            control.release("owner/repo", "")
        self.assertFalse(control.ref_exists("refs/tags/v1.2.3"))
        self.assertTrue(control.ref_exists("refs/remotes/origin/release/next-v1.2.3"))

    def test_migration_advances_old_tag_without_moving_it(self):
        self.git("tag", "-a", "v1.2.3", self.main, "-m", "Original release")
        original = self.git("rev-parse", "v1.2.3")
        self.git("push", "origin", "refs/tags/v1.2.3")
        self.write("new.txt", "Main has advanced since release\n")
        self.main = self.commit("New work")
        self.git("push", "origin", "main")
        with self.assertRaisesRegex(ValueError, "already exists"):
            control.release("owner/repo", "")
        control.release("owner/repo", "", advance_only=True)
        self.assertEqual(self.git("rev-parse", "v1.2.3"), original)
        self.assertEqual(policy.version(self.prs[-1]["head"]["sha"]), "1.2.4")
        self.assertEqual(self.statuses[-1][1]["state"], "success")

    def test_migration_cannot_create_release(self):
        with self.assertRaisesRegex(ValueError, "Advance-only"):
            control.release("owner/repo", "", advance_only=True)
        self.assertFalse(control.ref_exists("refs/tags/v1.2.3"))

    def test_rerun_after_completed_handoff_never_releases_next_version(self):
        original = self.main
        control.release("owner/repo", "", release_sha=original)
        self.git("push", "origin", f"{self.prs[0]['head']['sha']}:refs/heads/main")
        control.release("owner/repo", "", release_sha=original)
        self.assertFalse(control.ref_exists("refs/tags/v1.2.4"))
        self.assertEqual(len(self.prs), 1)

    def test_old_dispatch_before_tag_fails_if_main_moved(self):
        self.write("moved.txt", "New main commit\n")
        moved = self.commit("Moved main")
        self.git("push", "origin", f"{moved}:refs/heads/main")
        with self.assertRaisesRegex(ValueError, "main moved since"):
            control.release("owner/repo", "", release_sha=self.main)
        self.assertFalse(control.ref_exists("refs/tags/v1.2.3"))

    def test_status_failure_aborts_before_publishing_tag(self):
        self.prs = [self.pr(self.main)]
        with (
            patch.object(control, "status", side_effect=RuntimeError("API outage")),
            self.assertRaisesRegex(RuntimeError, "Handoff status refresh incomplete"),
        ):
            control.release("owner/repo", "")
        self.assertIsNone(control.remote_tag("v1.2.3"))

    def test_retry_publishes_previously_unpushed_local_tag(self):
        head = self.handoff(tagged=False)
        self.git("tag", "-a", "v1.2.3", self.main, "-m", "Unpushed release")
        self.prs = [self.pr(head, policy.branch("1.2.3"))]
        control.release("owner/repo", "")
        self.assertEqual(control.remote_tag("v1.2.3"), self.main)

    def test_post_tag_race_repaired_with_advance_only(self):
        original = self.main
        control.release("owner/repo", "")
        tag = self.git("rev-parse", "v1.2.3")
        self.git("checkout", "--detach", self.main)
        self.write("moved.txt", "Raced main merge\n")
        self.main = self.commit("Moved main after final check")
        self.git("push", "origin", f"{self.main}:refs/heads/main")
        with self.assertRaisesRegex(ValueError, "already exists"):
            control.release("owner/repo", "", release_sha=self.main)
        control.release("owner/repo", "", advance_only=True, release_sha=self.main)
        self.assertEqual(self.git("rev-parse", "v1.2.3"), tag)
        marker = self.git("rev-parse", "origin/release/next-v1.2.3")
        policy.validate_bump(self.main, marker)
        self.assertEqual(self.git("rev-parse", f"{marker}^"), self.main)
        self.assertEqual(self.statuses[-1][0], marker)
        self.assertEqual(self.statuses[-1][1]["state"], "success")
        self.git("push", "origin", f"{marker}:refs/heads/main")
        self.git("push", "origin", "--delete", "release/next-v1.2.3")
        control.release("owner/repo", "", release_sha=original)
        self.assertFalse(control.ref_exists("refs/tags/v1.2.4"))


class MainCITests(GitFixture):
    def test_release_requires_both_validated_shas_to_match(self):
        for apple, packages in [
            (None, None),
            (self.main, None),
            (None, self.main),
            ("a" * 40, self.main),
            (self.main, "a" * 40),
        ]:
            env = {
                name: value
                for name, value in [
                    ("VALIDATED_APPLE_SHA", apple),
                    ("VALIDATED_PACKAGES_SHA", packages),
                ]
                if value
            }
            with (
                self.subTest(env=env),
                patch.dict(os.environ, env, clear=True),
                self.assertRaises(ValueError),
            ):
                control.require_release_validation(self.main)
        with patch.dict(
            os.environ,
            {"VALIDATED_APPLE_SHA": self.main, "VALIDATED_PACKAGES_SHA": self.main},
        ):
            control.require_release_validation(self.main)

    def workflow(self, name, conclusion="success", status="completed"):
        return {
            "name": name,
            "conclusion": conclusion,
            "status": status,
            "html_url": "https://example.test/run",
        }

    def runs(self):
        return [
            self.workflow(name)
            for name in ["API tests", "cross", "web", "windows", "Maple package types"]
        ]

    def test_green_main_and_latest_run_wins(self):
        runs = self.runs() + [self.workflow("cross", "failure")]
        with patch.object(
            control, "run", return_value=json.dumps([{"workflow_runs": runs}])
        ):
            control.require_green_main("owner/repo", self.main)

    def test_missing_red_or_pending_main_blocks_release(self):
        for runs in [
            self.runs()[:-1],
            [self.workflow("cross", "failure"), *self.runs()],
            [self.workflow("apple", None, "in_progress"), *self.runs()],
        ]:
            with (
                self.subTest(runs=runs),
                patch.object(
                    control, "run", return_value=json.dumps([{"workflow_runs": runs}])
                ),
                self.assertRaises(ValueError),
            ):
                control.require_green_main("owner/repo", self.main)
