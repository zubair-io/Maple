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

    def run_child(self, source, recapture=0.25, idle=0.12):
        with (
            contextlib.redirect_stdout(io.StringIO()),
            patch.object(runner, "IDLE_SECONDS", idle),
            patch.object(runner, "RECAPTURE_SECONDS", recapture),
            patch.object(runner, "POLL_SECONDS", 0.02),
        ):
            return runner.run(
                [sys.executable, "-u", "-c", source], self.log, self.diagnostics
            )

    def record_captures(self):
        """A capture_stacks stand-in that drops `captured-<n>` markers, so a
        child can wait for a capture instead of racing the watcher's clock."""
        destinations = []

        def capture(_pid, destination):
            destinations.append(destination)
            (self.root / f"captured-{len(destinations)}").touch()

        return patch.object(runner, "capture_stacks", side_effect=capture), destinations

    def capture_wait_source(self, number):
        marker = self.root / f"captured-{number}"
        return (
            "import time, pathlib\n"
            "deadline = time.monotonic() + 10\n"
            f"while not pathlib.Path({str(marker)!r}).exists() and time.monotonic() < deadline:\n"
            "    time.sleep(.01)\n"
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
            self.assertEqual(self.run_child(source, idle=2), 0)
        capture.assert_not_called()

    def test_sampling_failure_cannot_change_test_result(self):
        with patch.object(
            runner, "capture_stacks", side_effect=OSError("sample unavailable")
        ):
            status = self.run_child(
                "import time; print(\"Test Case '-[Suite test]' started.\"); time.sleep(.3)"
            )
        self.assertEqual(status, 0)
        (error,) = self.diagnostics.glob("capture-01-*/capture-error.txt")
        self.assertIn("sample unavailable", error.read_text())

    def test_a_long_silence_is_sampled_again_not_only_once(self):
        """#4991: the first sample lands on a healthy long test; a later stall
        in the same silence must still be captured."""
        source = (
            "print(\"Test Case '-[Suite test]' started.\", flush=True)\n"
            + self.capture_wait_source(2)
        )
        recording, destinations = self.record_captures()
        with recording:
            self.assertEqual(self.run_child(source), 0)
        self.assertGreaterEqual(len(destinations), 2, destinations)
        self.assertEqual(len(set(destinations)), len(destinations), destinations)

    def test_output_rearms_capture_for_the_next_silence(self):
        """A new silence after output is sampled at IDLE_SECONDS, not only
        once RECAPTURE_SECONDS has passed since the previous sample."""
        source = (
            "print(\"Test Case '-[Suite test]' started.\", flush=True)\n"
            + self.capture_wait_source(1)
            + "print('progress', flush=True)\n"
            + self.capture_wait_source(2)
        )
        recording, destinations = self.record_captures()
        with recording:
            self.assertEqual(self.run_child(source, recapture=60), 0)
        self.assertEqual(len(destinations), 2, destinations)

    def test_child_environment_requests_unbuffered_foundation_output(self):
        """#4991: block-buffered XCTest output left tests.log ending tests
        before the one actually running."""
        status = self.run_child("import os; print(os.environ.get('NSUnbufferedIO'))")
        self.assertEqual(status, 0)
        self.assertEqual(self.log.read_text(), "YES\n")

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
            capture = min(self.diagnostics.iterdir())
            processes = (capture / "processes.txt").read_text().splitlines()
            pids = {int(line.split()[0]) for line in processes}
            self.assertEqual(len(pids), 2, processes)
            self.assertNotIn(unrelated.pid, pids)
            for pid in pids:
                stack = (capture / f"stack-{pid}.txt").read_text()
                self.assertIn("Call graph:", stack)
            self.assertIn("passed.", self.log.read_text())
        finally:
            unrelated.terminate()
            unrelated.wait(timeout=5)


if __name__ == "__main__":
    unittest.main()
