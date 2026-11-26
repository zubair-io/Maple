import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import install_smoke

NOT_FOUND = "E: Failed to fetch http://archive.invalid/libtiff6_4.5.1_amd64.deb  404\n"
INCOMPLETE = "E: Unable to fetch some archives, maybe run apt-get update?\n"
UNMET = "E: Unable to correct problems, you have held broken packages.\n"
INSTALL = ["apt-get", "-y", "install", "libtiff6"]
REFRESH = ["apt-get", "update"]


def finished(code: int, output: str = "") -> subprocess.CompletedProcess:
    return subprocess.CompletedProcess([], code, stdout=output)


class AptRetryTest(unittest.TestCase):
    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.hook = Path(directory.name) / "docker-clean"
        self.hook.write_text("discard downloads\n")
        self.run_process = self.patch(subprocess, "run")
        self.sleep = self.patch(install_smoke.time, "sleep")
        self.patch(install_smoke, "DISCARD_DOWNLOADS_HOOK", self.hook)

    def patch(self, target: object, name: str, *replacement: object) -> mock.Mock:
        patcher = mock.patch.object(target, name, *replacement)
        self.addCleanup(patcher.stop)
        return patcher.start()

    def apt(self, *results: subprocess.CompletedProcess) -> None:
        self.run_process.side_effect = results
        install_smoke.apt("install", "libtiff6", cwd=Path("/packages"))

    def commands(self) -> list[list[str]]:
        return [list(call.args[0]) for call in self.run_process.call_args_list]

    def slept(self) -> list[int]:
        return [call.args[0] for call in self.sleep.call_args_list]

    def test_each_download_failure_refreshes_the_index_and_installs_again(self) -> None:
        for failure in (NOT_FOUND, INCOMPLETE):
            with self.subTest(failure):
                self.run_process.reset_mock()
                self.sleep.reset_mock()
                self.apt(finished(100, failure), finished(0), finished(0))
                self.assertEqual(self.commands(), [INSTALL, REFRESH, INSTALL])
                self.assertEqual(self.slept(), [15])

    def test_the_install_reads_both_streams_in_the_package_directory(self) -> None:
        self.apt(finished(0))
        options = self.run_process.call_args.kwargs
        self.assertEqual(options["stderr"], subprocess.STDOUT)
        self.assertEqual(options["cwd"], Path("/packages"))
        self.assertEqual(options["env"]["DEBIAN_FRONTEND"], "noninteractive")

    def test_a_retry_keeps_the_packages_already_downloaded(self) -> None:
        self.apt(finished(100, NOT_FOUND), finished(0), finished(0))
        self.assertFalse(self.hook.exists())

    def test_a_failure_that_is_not_a_download_fails_at_once(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "exited with 100"):
            self.apt(finished(100, UNMET))
        self.assertEqual(self.commands(), [INSTALL])
        self.assertEqual(self.slept(), [])
        self.assertTrue(self.hook.exists())

    def test_a_failed_index_refresh_fails_the_install(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "exited with 100"):
            self.apt(finished(100, NOT_FOUND), finished(100))
        self.assertEqual(self.commands(), [INSTALL, REFRESH])

    def test_an_archive_that_stays_broken_still_fails(self) -> None:
        attempts = [finished(100, NOT_FOUND), finished(0)] * 3
        with self.assertRaisesRegex(RuntimeError, "exited with 100"):
            self.apt(*attempts, finished(100, NOT_FOUND))
        self.assertEqual(self.slept(), [15, 60, 180])
        self.assertEqual(self.commands().count(INSTALL), 4)


if __name__ == "__main__":
    unittest.main()
