"""Exercise live subprocess exit propagation and stalled XCTest diagnostics."""

import contextlib
import importlib.util
import io
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "runner", Path(__file__).with_name("run-swift-regressions.py")
)
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


class SwiftRegressionRunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.log = self.root / "tests.log"
        self.diagnostics = self.root / "diagnostics"

    def run_child(self, source):
        with (
            contextlib.redirect_stdout(io.StringIO()),
            patch.object(runner, "IDLE_SECONDS", 0.12),
            patch.object(runner, "POLL_SECONDS", 0.02),
        ):
            return runner.run(
                [sys.executable, "-u", "-c", source], self.log, self.diagnostics
            )

    def test_preserves_failure_status_and_both_output_streams(self):
        with patch.object(runner, "capture_stacks") as capture:
            status = self.run_child(
                "import sys; print('real stdout'); print('real stderr', file=sys.stderr); sys.exit(7)"
            )
        self.assertEqual(status, 7)
        self.assertEqual(self.log.read_text(), "real stdout\nreal stderr\n")
        capture.assert_not_called()

    def test_build_silence_does_not_trigger_xctest_diagnostics(self):
        with patch.object(runner, "capture_stacks") as capture:
            status = self.run_child(
                "import time; print('Compiling MapleCore'); time.sleep(.3)"
            )
        self.assertEqual(status, 0)
        capture.assert_not_called()

    def test_continuing_test_progress_does_not_trigger_diagnostics(self):
        source = (
            "import time; print(\"Test Suite 'Selected tests' started\"); "
            "[(print('progress'), time.sleep(.04)) for _ in range(8)]"
        )
        with patch.object(runner, "capture_stacks") as capture:
            self.assertEqual(self.run_child(source), 0)
        capture.assert_not_called()

    def test_sampling_failure_cannot_change_test_result(self):
        with patch.object(
            runner, "capture_stacks", side_effect=OSError("sample unavailable")
        ):
            status = self.run_child(
                "import time; print(\"Test Case '-[Suite test]' started.\"); time.sleep(.3)"
            )
        self.assertEqual(status, 0)
        self.assertIn(
            "sample unavailable", (self.diagnostics / "capture-error.txt").read_text()
        )

    def test_signal_exit_cannot_be_reported_as_success(self):
        self.assertEqual(
            self.run_child("import os, signal; os.kill(os.getpid(), signal.SIGTERM)"),
            143,
        )

    @unittest.skipUnless(sys.platform == "darwin", "native macOS sample tool")
    def test_real_stalled_child_captures_owned_native_stacks_and_then_finishes(self):
        child = self.root / "xctest-child.py"
        child.write_text(
            "import time\nprint(\"Test Case '-[Suite test]' started.\", flush=True)\n"
            "time.sleep(12)\nprint(\"Test Case '-[Suite test]' passed.\", flush=True)\n"
        )
        source = f"import subprocess,sys; sys.exit(subprocess.call([sys.executable, '-u', {str(child)!r}]))"
        unrelated = subprocess.Popen(
            [sys.executable, "-c", "import time; time.sleep(60)"]
        )
        try:
            self.assertEqual(self.run_child(source), 0)
            processes = (self.diagnostics / "processes.txt").read_text().splitlines()
            pids = {int(line.split()[0]) for line in processes}
            self.assertEqual(len(pids), 2, processes)
            self.assertNotIn(unrelated.pid, pids)
            for pid in pids:
                stack = (self.diagnostics / f"stack-{pid}.txt").read_text()
                self.assertIn("Call graph:", stack)
            self.assertIn("passed.", self.log.read_text())
        finally:
            unrelated.terminate()
            unrelated.wait(timeout=5)


if __name__ == "__main__":
    unittest.main()
