"""Test a built helper with unchanged, stopped, and changed settings after a lock wait.

Usage: python3 test-backup-agent-ownership.py HELPER BackupSettings.swift
"""

import fcntl
import os
import select
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

WRITER = """import Foundation
@main struct Writer {
  static func main() throws {
    precondition(Bundle.main.bundleIdentifier == nil)
    precondition(ProcessInfo.processInfo.processName.hasPrefix("maple-ownership-"))
    if CommandLine.arguments[1] == "cleanup" {
      UserDefaults.standard.removePersistentDomain(forName: ProcessInfo.processInfo.processName)
      UserDefaults.standard.synchronize()
      return
    }
    var settings = BackupSettings.defaults
    settings.serverURL = CommandLine.arguments[2]
    settings.libraryId = CommandLine.arguments[1] == "change" ? "new" : "old"
    settings.save()
    BackupSettings.isStoppedByUser = CommandLine.arguments[1] == "stop"
    precondition(UserDefaults.standard.synchronize())
    print(settings.stateDatabaseFilename)
  }
}
"""


def run_case(helper, writer_template, directory, mode):
    name = "maple-ownership-" + uuid.uuid4().hex
    writer = directory / "writer" / name
    agent = directory / "agent" / name
    writer.parent.mkdir()
    agent.parent.mkdir()
    shutil.copy2(writer_template, writer)
    shutil.copy2(helper, agent)
    home = directory / "home"
    home.mkdir()
    env = dict(os.environ, CFFIXED_USER_HOME=str(home.resolve()))
    with socket.socket() as server:
        server.bind(("127.0.0.1", 0))
        server.listen()
        address = f"http://127.0.0.1:{server.getsockname()[1]}"

        def write(mode):
            return subprocess.check_output(
                [writer, mode, address], env=env, text=True
            ).strip()

        filename = write("initial")
        database = home / "Library/Application Support/Maple" / filename
        database.parent.mkdir(parents=True, exist_ok=True)
        with database.with_suffix(".sqlite.engine.lock").open("w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            process = subprocess.Popen(
                [agent], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE
            )
            try:
                deadline = time.monotonic() + 5
                while (
                    not database.exists()
                    and process.poll() is None
                    and time.monotonic() < deadline
                ):
                    time.sleep(0.01)
                assert database.exists() and process.poll() is None, (
                    "helper did not reach ownership wait"
                )
                time.sleep(0.2)
                write(mode)
                fcntl.flock(lock, fcntl.LOCK_UN)
                deadline = time.monotonic() + 2
                while time.monotonic() < deadline:
                    if select.select([server], [], [], 0.01)[0]:
                        assert mode == "unchanged", (
                            f"{mode}: stale helper continued into network resolution"
                        )
                        print(
                            "PASS unchanged: current helper continued after ownership"
                        )
                        return
                    if process.poll() is not None:
                        assert mode != "unchanged", (
                            "current helper exited without resuming"
                        )
                        assert process.returncode == 0, process.communicate()[
                            1
                        ].decode()
                        print(
                            f"PASS {mode}: stale helper exited before recovery/network"
                        )
                        return
                raise AssertionError(
                    f"{mode}: helper did not exit after stale settings"
                )
            finally:
                if process.poll() is None:
                    process.terminate()
                process.communicate(timeout=5)
                write("cleanup")


def main():
    helper = Path(sys.argv[1]).resolve()
    source = Path(sys.argv[2]).resolve()
    with tempfile.TemporaryDirectory(prefix="maple-ownership-") as temp:
        root = Path(temp)
        swift = root / "Writer.swift"
        swift.write_text(WRITER)
        writer = root / "writer-template"
        subprocess.run(
            ["xcrun", "swiftc", str(source), str(swift), "-o", str(writer)], check=True
        )
        failures = []
        for mode in ["stop", "change", "unchanged"]:
            directory = root / mode
            directory.mkdir()
            try:
                run_case(helper, writer, directory, mode)
            except AssertionError as error:
                print(f"FAIL {error}")
                failures.append(str(error))
        if failures:
            raise SystemExit(1)


if __name__ == "__main__":
    main()
