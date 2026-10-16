"""Exercise Play's HTTP upload contract and the privileged workflow boundary."""

import hashlib
import json
import os
import subprocess
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import yaml
from android_publish import PACKAGE, Publisher

ROOT = Path(__file__).resolve().parents[1]


class PlayTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.bundle = Path(self.directory.name) / "app.aab"
        self.bundle.write_bytes(bytes(range(256)) * 2048)
        self.digest = hashlib.sha256(self.bundle.read_bytes()).hexdigest()
        self.calls = []
        self.releases = []
        self.bundles = []
        self.fail_upload = False
        self.fail_commit = False
        self.upload_digest = self.digest
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def respond(self):
                body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                owner.calls.append((self.command, self.path, body))
                owner.assertEqual(self.headers["Authorization"], "Bearer test-token")
                owner.assertIn(f"applications/{PACKAGE}/edits", self.path)
                status, result = 200, {}
                if self.path.endswith("/edits"):
                    result = {"id": "edit-1"}
                elif self.command == "GET" and self.path.endswith("/tracks/internal"):
                    result = {"track": "internal", "releases": owner.releases}
                elif self.command == "GET" and self.path.endswith("/bundles"):
                    result = {"bundles": owner.bundles}
                elif self.path.endswith("/bundles?uploadType=media"):
                    owner.assertEqual(body, owner.bundle.read_bytes())
                    owner.assertEqual(
                        self.headers["Content-Type"], "application/octet-stream"
                    )
                    result = {"versionCode": 7, "sha256": owner.upload_digest}
                    if owner.fail_upload:
                        status, result = 403, {"error": "permission denied"}
                elif ":commit?" in self.path:
                    owner.assertEqual(body, b"")
                    owner.assertIn(
                        "changesInReviewBehavior=ERROR_IF_IN_REVIEW", self.path
                    )
                    if owner.fail_commit:
                        status, result = 400, {"error": "changes already in review"}
                elif self.command == "DELETE":
                    status = 404
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(result).encode())

            do_GET = do_POST = do_PUT = do_DELETE = respond

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.publisher = Publisher(
            "test-token", f"http://127.0.0.1:{self.server.server_port}"
        )

    def publish(self):
        self.publisher.publish(self.bundle, 7, "0.1.5 (7) abc1234")

    def test_streams_exact_bundle_then_commits_internal_only(self):
        self.publish()
        puts = [call for call in self.calls if call[0] == "PUT"]
        self.assertEqual(len(puts), 1)
        track = json.loads(puts[0][2])
        self.assertEqual(track["track"], "internal")
        self.assertEqual(track["releases"][0]["versionCodes"], ["7"])
        self.assertEqual(track["releases"][0]["status"], "completed")
        self.assertTrue(any(":commit?" in path for _, path, _ in self.calls))

    def test_rerun_after_upload_reuses_matching_bundle(self):
        self.bundles = [{"versionCode": 7, "sha256": self.digest}]
        self.publish()
        self.assertFalse(any("uploadType" in path for _, path, _ in self.calls))
        self.assertTrue(any(method == "PUT" for method, _, _ in self.calls))

    def test_successful_rerun_is_idempotent(self):
        self.bundles = [{"versionCode": 7, "sha256": self.digest}]
        self.releases = [{"versionCodes": ["7"], "status": "completed"}]
        self.publish()
        self.assertFalse(any(method == "PUT" for method, _, _ in self.calls))

    def test_newer_internal_build_is_never_downgraded(self):
        self.releases = [{"versionCodes": ["8"], "status": "completed"}]
        self.publish()
        self.assertFalse(any("uploadType" in path for _, path, _ in self.calls))
        self.assertFalse(any(method == "PUT" for method, _, _ in self.calls))

    def test_hash_mismatch_and_api_errors_never_commit(self):
        for failure in ("hash", "permission"):
            with self.subTest(failure=failure):
                self.calls.clear()
                self.upload_digest = "bad" if failure == "hash" else self.digest
                self.fail_upload = failure == "permission"
                with self.assertRaises((RuntimeError, ValueError)):
                    self.publish()
                self.assertFalse(any(":commit?" in path for _, path, _ in self.calls))

    def test_active_review_is_not_cancelled_or_silently_waived(self):
        self.fail_commit = True
        with self.assertRaisesRegex(RuntimeError, "changes already in review"):
            self.publish()


class DistributionBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.workflow = yaml.safe_load(
            (ROOT / ".github/workflows/android-distribution.yml").read_text()
        )
        self.jobs = self.workflow["jobs"]

    def test_only_successful_main_push_ci_can_supply_a_publication_sha(self):
        condition = self.jobs["signed-build"]["if"]
        for required in (
            "conclusion == 'success'",
            "event == 'push'",
            "head_branch == 'main'",
            "head_repository.full_name == github.repository",
        ):
            self.assertIn(required, condition)
        self.assertEqual(
            self.jobs["internal-testing"]["if"], "github.event_name == 'workflow_run'"
        )
        self.assertEqual(self.workflow["permissions"], {"contents": "read"})
        self.assertNotIn("id-token", self.jobs["signed-build"].get("permissions", {}))

    def test_one_counter_and_exact_artifact_are_shared_by_all_build_triggers(self):
        self.assertEqual(self.workflow["concurrency"]["queue"], "max")
        self.assertFalse(self.workflow["concurrency"]["cancel-in-progress"])
        build = self.jobs["signed-build"]
        signing = next(
            step
            for step in build["steps"]
            if "ANDROID_UPLOAD_KEYSTORE_BASE64" in step.get("env", {})
        )
        self.assertEqual(
            signing["env"]["MAPLE_VERSION_CODE"],
            "${{ steps.version.outputs.version_code }}",
        )
        publish = self.jobs["internal-testing"]
        upload = next(
            step
            for step in publish["steps"]
            if "GOOGLE_PLAY_ACCESS_TOKEN" in step.get("env", {})
        )
        self.assertEqual(
            upload["env"]["VERSION_CODE"],
            "${{ needs.signed-build.outputs.version_code }}",
        )
        self.assertIn("sha256sum --check", upload["run"])
        auth = next(step for step in publish["steps"] if step.get("id") == "auth")
        self.assertEqual(auth["with"]["create_credentials_file"], False)
        self.assertEqual(
            auth["with"]["access_token_scopes"],
            "https://www.googleapis.com/auth/androidpublisher",
        )

    def test_real_version_step_reserves_bootstrap_and_rejects_invalid_releases(self):
        step = next(
            step
            for step in self.jobs["signed-build"]["steps"]
            if step.get("id") == "version"
        )
        version = json.loads((ROOT / "src/maple/package.json").read_text())["version"]
        for number, tag, code in (
            (1, f"v{version}", 2),
            (2, "", 3),
            (3, "vwrong", None),
            (0, "", None),
            (2100000000, "", None),
        ):
            with (
                self.subTest(number=number, tag=tag),
                tempfile.TemporaryDirectory() as directory,
            ):
                output = Path(directory) / "output"
                result = subprocess.run(
                    ["bash", "-e", "-c", step["run"]],
                    check=False,
                    cwd=ROOT,
                    env=os.environ
                    | {
                        "GITHUB_RUN_NUMBER": str(number),
                        "TAG": tag,
                        "GITHUB_OUTPUT": str(output),
                    },
                    capture_output=True,
                    text=True,
                )
                if code is None:
                    self.assertNotEqual(result.returncode, 0)
                else:
                    self.assertEqual(result.returncode, 0, result.stderr)
                    values = dict(
                        line.split("=", 1) for line in output.read_text().splitlines()
                    )
                    self.assertEqual(values["version_code"], str(code))
                    self.assertEqual(values["version"], version)
                    self.assertRegex(values["sha"], r"^[0-9a-f]{40}$")

    def test_release_coordinator_waits_for_apk_bundle_and_checksums(self):
        release = yaml.safe_load((ROOT / ".github/workflows/release.yml").read_text())
        steps = release["jobs"]["publish-release"]["steps"]
        wait = next(step["run"] for step in steps if "Wait for" in step.get("name", ""))
        for filename in (
            "Maple-Android-$VERSION.apk",
            "Maple-Android-$VERSION.aab",
            "Maple-Android-SHA256SUMS.txt",
            "Maple-Android-upload-certificate.pem",
        ):
            self.assertIn(filename, wait)
        self.assertLess(
            next(
                i for i, step in enumerate(steps) if "Wait for" in step.get("name", "")
            ),
            next(
                i
                for i, step in enumerate(steps)
                if step.get("name") == "Publish complete release"
            ),
        )


if __name__ == "__main__":
    unittest.main()
