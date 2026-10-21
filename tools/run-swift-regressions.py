#!/usr/bin/env python3
"""Stream the real Swift gate and sample a stalled XCTest process (#4023).

Diagnostics never cancel, retry, skip, or change the test command's exit status.
The existing workflow validates complete XCTest execution after this returns.

A silence is sampled again every RECAPTURE_SECONDS (#4991): the first sample
can land on a healthy test that is merely quiet for minutes, and a real stall
that starts later in the same silence must still be captured.
"""

import argparse
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

IDLE_SECONDS = 120
RECAPTURE_SECONDS = 600
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
    # Every owned process: the launcher can be waiting for XCTest or holding a
    # lock, and a test's helper server can be what XCTest is waiting on.
    for pid in processes:
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
    state = {"started": False, "last_output": time.monotonic(), "last_capture": None}
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
            # stdio block-buffers XCTest's output into a pipe, so tests.log
            # could end tests before the one actually running; NSUnbufferedIO
            # makes Foundation unbuffer it (#4991).
            env={**os.environ, "NSUnbufferedIO": "YES"},
        ) as process,
    ):

        def watch():
            captures = 0
            while not stopped.wait(POLL_SECONDS):
                now = time.monotonic()
                with lock:
                    last_output, last_capture = (
                        state["last_output"],
                        state["last_capture"],
                    )
                    due = (
                        state["started"]
                        and now - last_output >= IDLE_SECONDS
                        and (
                            last_capture is None
                            or last_capture < last_output
                            or now - last_capture >= RECAPTURE_SECONDS
                        )
                    )
                    if due:
                        state["last_capture"] = now
                if due and process.poll() is None:
                    captures += 1
                    silent = int(now - last_output)
                    print(
                        f"XCTest output stalled for {silent}s; capturing owned process stacks",
                        flush=True,
                    )
                    capture_dir = destination / f"capture-{captures:02d}-{silent}s"
                    try:
                        capture_stacks(process.pid, capture_dir)
                    except (OSError, subprocess.SubprocessError) as error:
                        capture_dir.mkdir(parents=True, exist_ok=True)
                        (capture_dir / "capture-error.txt").write_text(str(error))

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
