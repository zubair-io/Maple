"""Exercise the real release script and PlistBuddy against archive fixtures."""

import os
import plistlib
import subprocess
import tempfile
import unittest
from pathlib import Path


@unittest.skipUnless(Path("/usr/libexec/PlistBuddy").exists(), "requires macOS")
class ArchivePlatformTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.archive = Path(self.temp.name) / "Maple Archive.xcarchive"
        self.archive.mkdir()
        self.script = Path(__file__).with_name("ci_post_xcodebuild.sh")

    def plist(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(plistlib.dumps(value, fmt=plistlib.FMT_BINARY))

    def fixture(self, platform, mac=False):
        self.plist(
            self.archive / "Info.plist",
            {
                "ApplicationProperties": {
                    "ApplicationPath": "Applications/Maple App.app"
                }
            },
        )
        info = self.archive / "Products/Applications/Maple App.app"
        info /= "Contents/Info.plist" if mac else "Info.plist"
        self.plist(info, {"CFBundleSupportedPlatforms": [platform]})
        return info

    def run_script(self, **overrides):
        # No inherited signing/network credentials: the macOS path must stop
        # at the credential gate, before any packaging or external calls.
        env = {
            "PATH": os.defpath,
            "CI_XCODEBUILD_ACTION": "archive",
            "CI_XCODEBUILD_EXIT_CODE": "0",
            "CI_TAG": "v0.1.3",
            "CI_COMMIT": "test-commit",
            "CI_ARCHIVE_PATH": str(self.archive),
            **overrides,
        }
        return subprocess.run(
            ["/bin/bash", str(self.script)],
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )

    def test_mac_archive_reaches_distribution_credential_gate(self):
        self.fixture("MacOSX", mac=True)
        result = self.run_script()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("missing Xcode Cloud environment variable(s)", result.stderr)
        self.assertNotIn("skipping", result.stdout)

    def test_known_non_mac_archives_skip_without_credentials(self):
        for platform in ("iPhoneOS", "AppleTVOS", "WatchOS", "XROS"):
            with self.subTest(platform=platform):
                self.fixture(platform)
                result = self.run_script()
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(f"platform is {platform}, not macOS", result.stdout)

    def test_unknown_platform_fails(self):
        self.fixture("unexpected", mac=True)
        result = self.run_script()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unsupported archive platform", result.stderr)

    def test_missing_or_invalid_bundle_metadata_fails(self):
        for data in (None, b"invalid plist", plistlib.dumps({})):
            with self.subTest(data=data):
                info = self.fixture("MacOSX", mac=True)
                if data is None:
                    info.unlink()
                else:
                    info.write_bytes(data)
                result = self.run_script()
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn("skipping", result.stdout)

    def test_missing_archive_application_path_fails(self):
        self.plist(self.archive / "Info.plist", {"ApplicationProperties": {}})
        self.assertNotEqual(self.run_script().returncode, 0)

    def test_non_release_and_failed_archives_still_skip(self):
        for overrides in (
            {"CI_TAG": ""},
            {"CI_XCODEBUILD_ACTION": "build"},
            {"CI_XCODEBUILD_EXIT_CODE": "1"},
        ):
            with self.subTest(overrides=overrides):
                self.assertEqual(self.run_script(**overrides).returncode, 0)


if __name__ == "__main__":
    unittest.main()
