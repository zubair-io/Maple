#!/usr/bin/env python3
"""Run the packaged Wayland startup check under an owned headless Weston (#4317)."""

import argparse
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("--accessibility", action="store_true")
    args = parser.parse_args()
    binary = args.binary.resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix="maple-weston-") as directory:
        runtime = Path(directory)
        runtime.chmod(0o700)
        environment = os.environ.copy()
        environment.pop("DISPLAY", None)
        environment["XDG_RUNTIME_DIR"] = str(runtime)
        environment["WAYLAND_DISPLAY"] = "maple-test"
        with (runtime / "weston.log").open("w+") as log:
            compositor = subprocess.Popen(
                [
                    "weston",
                    "--backend=headless-backend.so",
                    "--renderer=pixman",
                    "--width=1280",
                    "--height=800",
                    "--socket=maple-test",
                    "--idle-time=0",
                ],
                env=environment,
                stdout=log,
                stderr=log,
            )
            try:
                deadline = time.monotonic() + 10
                while not (runtime / "maple-test").is_socket():
                    if compositor.poll() is not None or time.monotonic() >= deadline:
                        log.seek(0)
                        raise RuntimeError(f"Weston did not start: {log.read()}")
                    time.sleep(0.1)
                # Keep the caller's desktop environment untouched; the child checker
                # and its app inherit only this compositor's private socket.
                subprocess.run(
                    [
                        sys.executable,
                        str(Path(__file__).with_name("wayland_smoke.py")),
                        str(binary),
                    ],
                    env=environment,
                    check=True,
                )
                if args.accessibility:
                    subprocess.run(
                        [
                            sys.executable,
                            str(
                                Path(__file__).resolve().parents[3]
                                / "tools/qualification/linux-native/accessibility_smoke.py"
                            ),
                            str(binary),
                        ],
                        env=environment,
                        check=True,
                    )
                if compositor.poll() is not None:
                    raise RuntimeError("Weston exited during the application check")
            finally:
                if compositor.poll() is None:
                    compositor.terminate()
                    try:
                        compositor.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        compositor.kill()
                        compositor.wait()


if __name__ == "__main__":
    main()
