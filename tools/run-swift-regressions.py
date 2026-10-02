#!/usr/bin/env python3
"""Stream the real Swift gate and sample a stalled XCTest process (#4023).

Diagnostics never cancel, retry, skip, or change the test command's exit status.
The existing workflow validates complete XCTest execution after this returns.
"""

import argparse
import subprocess
import sys
import threading
import time
from pathlib import Path

IDLE_SECONDS = 120
POLL_SECONDS = 5


def owned_processes(root_pid):
    """Read ancestry before selecting only our command and its descendants."""
    result = subprocess.run(
        ["ps", "-axo", "pid=,ppid=,command="],
        capture_output=True,
        text=True,
        check=True,
        timeout=10,
    )
    processes = {}
    for line in result.stdout.splitlines():
        fields = line.strip().split(maxsplit=2)
        if len(fields) == 3:
            processes[int(fields[0])] = (int(fields[1]), fields[2])
    owned = {root_pid} if root_pid in processes else set()
    while True:
        descendants = {pid for pid, (parent, _) in processes.items() if parent in owned}
        expanded = owned | descendants
        if expanded == owned:
            return {pid: processes[pid] for pid in sorted(owned)}
        owned = expanded


def capture_stacks(root_pid, destination):
    destination.mkdir(parents=True, exist_ok=True)
    processes = owned_processes(root_pid)
    (destination / "processes.txt").write_text(
        "".join(
            f"{pid} {parent} {command}\n"
            for pid, (parent, command) in processes.items()
        )
    )
    # Sample the launcher too: it can be waiting for XCTest or holding a lock.
    for pid, (_, command) in processes.items():
        if pid == root_pid or "xctest" in command.lower():
            with (destination / f"sample-{pid}.log").open("w") as log:
                try:
                    subprocess.run(
                        [
                            "sample",
                            str(pid),
                            "5",
                            "1",
                            "-file",
                            str(destination / f"stack-{pid}.txt"),
                        ],
                        stdout=log,
                        stderr=subprocess.STDOUT,
                        timeout=15,
                        check=False,
                    )
                except (OSError, subprocess.TimeoutExpired) as error:
                    log.write(f"Unable to sample {pid}: {error}\n")


def run(command, log_path, destination):
    log_path.parent.mkdir(parents=True, exist_ok=True)
    state = {"started": False, "last_output": time.monotonic()}
    lock = threading.Lock()
    stopped = threading.Event()
    with (
        log_path.open("w") as log,
        subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        ) as process,
    ):

        def watch():
            while not stopped.wait(POLL_SECONDS):
                with lock:
                    stalled = (
                        state["started"]
                        and time.monotonic() - state["last_output"] >= IDLE_SECONDS
                    )
                if stalled and process.poll() is None:
                    print(
                        "XCTest output stalled; capturing owned process stacks",
                        flush=True,
                    )
                    try:
                        capture_stacks(process.pid, destination)
                    except (OSError, subprocess.SubprocessError) as error:
                        destination.mkdir(parents=True, exist_ok=True)
                        (destination / "capture-error.txt").write_text(str(error))
                    return

        watcher = threading.Thread(target=watch, daemon=True)
        watcher.start()
        try:
            for line in process.stdout:
                log.write(line)
                log.flush()
                sys.stdout.write(line)
                sys.stdout.flush()
                with lock:
                    state["last_output"] = time.monotonic()
                    if (
                        "Test Suite 'Selected tests' started" in line
                        or "Test Case '-[" in line
                    ):
                        state["started"] = True
            status = process.wait()
        finally:
            stopped.set()
            watcher.join()
    return status if status >= 0 else 128 - status


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--log", type=Path, required=True)
    parser.add_argument("--diagnostics", type=Path, required=True)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("a test command is required after --")
    return run(command, args.log, args.diagnostics)


if __name__ == "__main__":
    sys.exit(main())
