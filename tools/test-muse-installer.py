#!/usr/bin/env python3
"""Exercise #4184 bootstrap with actual HTTP transport and official release bytes."""

import functools
import http.server
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("install-muse-opencode.sh").resolve()
SOURCE = SCRIPT.read_text()
VERSION = re.search(r"readonly version=(\S+)", SOURCE)[1]
ASSET = re.search(r"readonly asset=(\S+)", SOURCE)[1]
URL = f"https://github.com/anomalyco/opencode/releases/download/v{VERSION}/{ASSET}"
CURL = shutil.which("curl")
ARCHIVE = Path(sys.argv.pop(1)) if len(sys.argv) > 1 else None


class InstallerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workspace = tempfile.TemporaryDirectory(prefix="muse-installer-")
        cls.root = Path(cls.workspace.name)
        cls.archive = cls.root / "release.tar.gz"
        if ARCHIVE is not None:
            shutil.copyfile(ARCHIVE, cls.archive)
        else:
            subprocess.run(
                [CURL, "-fLsS", "--max-time", "180", URL, "-o", str(cls.archive)],
                check=True,
            )
        cls.server = http.server.ThreadingHTTPServer(
            ("127.0.0.1", 0),
            functools.partial(
                http.server.SimpleHTTPRequestHandler, directory=str(cls.root)
            ),
        )
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        cls.workspace.cleanup()

    def install(self, resource, fail_tar=False):
        with tempfile.TemporaryDirectory(prefix="muse-case-") as directory:
            root = Path(directory)
            commands = root / "commands"
            commands.mkdir()
            # Test-only redirect uses real curl against an owned HTTP server.
            # The production installer has no endpoint override or test setting.
            wrapper = commands / "curl"
            wrapper.write_text(
                "#!/usr/bin/env python3\nimport os,sys\n"
                f"args=[{('http://127.0.0.1:' + str(self.server.server_port) + resource)!r} if arg=={URL!r} else arg for arg in sys.argv[1:]]\n"
                f"os.execv({CURL!r}, [{CURL!r}]+args)\n"
            )
            wrapper.chmod(0o755)
            if fail_tar:
                tar = commands / "tar"
                tar.write_text(
                    "#!/bin/sh\necho 'Injected extractor failure' >&2\nexit 2\n"
                )
                tar.chmod(0o755)
            destination = root / "installation"
            result = subprocess.run(
                ["bash", str(SCRIPT), str(destination)],
                env=dict(
                    os.environ, PATH=str(commands) + os.pathsep + os.environ["PATH"]
                ),
                check=False,
                capture_output=True,
                text=True,
            )
            installed = destination / "opencode"
            if installed.exists():
                with installed.open("rb") as executable:
                    binary = executable.read(4)
            else:
                binary = None
            return result, binary

    def test_official_archive_installs_verified_linux_binary(self):
        result, binary = self.install("/release.tar.gz")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(binary, b"\x7fELF")
        self.assertIn(f"checksum-verified OpenCode {VERSION}", result.stdout)

    def test_http_missing_archive_reports_status_without_installing(self):
        result, binary = self.install("/missing.tar.gz")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("curl=22, HTTP=404", result.stderr)
        self.assertIsNone(binary)

    def test_transport_failure_reports_actual_curl_error(self):
        # Real curl cannot complete a request on the server's closed port.
        with tempfile.TemporaryDirectory() as directory:
            commands = Path(directory)
            curl = commands / "curl"
            curl.write_text(
                f"#!/bin/sh\nexec '{CURL}' --connect-timeout 1 --max-time 2 http://127.0.0.1:0\n"
            )
            curl.chmod(0o755)
            result = subprocess.run(
                ["bash", str(SCRIPT), str(commands / "out")],
                env=dict(
                    os.environ, PATH=str(commands) + os.pathsep + os.environ["PATH"]
                ),
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("download failed: curl=7", result.stderr)
            self.assertFalse((commands / "out/opencode").exists())

    def test_corrupt_archive_fails_checksum_before_extraction(self):
        (self.root / "corrupt.tar.gz").write_bytes(b"not the official archive")
        result, binary = self.install("/corrupt.tar.gz")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("SHA-256 mismatch", result.stderr)
        self.assertIsNone(binary)

    def test_extraction_error_never_publishes_binary(self):
        result, binary = self.install("/release.tar.gz", fail_tar=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn("Injected extractor failure", result.stderr)
        self.assertIsNone(binary)


if __name__ == "__main__":
    unittest.main()
