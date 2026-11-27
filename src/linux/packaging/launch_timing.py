#!/usr/bin/env python3
"""Time process start to the first painted frame of the Maple executable on X11 (#6096).

The toolkit keeps its window hidden until the first frame is painted, so the
moment the window becomes viewable is the moment the first frame is on screen.
"""
import argparse
import os
from pathlib import Path
import statistics
import subprocess
import tempfile
import time

import smoke

POLL_SECONDS = 0.02


def launch_once(binary: Path) -> float:
    with tempfile.TemporaryDirectory(prefix="maple-launch-timing-") as directory:
        root = Path(directory)
        photos = root / "photos"
        photos.mkdir()
        with (root / "launch.log").open("w+") as log:
            environment = os.environ.copy()
            environment.pop("WAYLAND_DISPLAY", None)
            started = time.monotonic()
            process = subprocess.Popen(
                [str(binary), str(photos)], cwd=root, env=environment, stdout=log, stderr=log
            )
            try:
                smoke.find_window(process, log, viewable=True, poll=POLL_SECONDS)
                return time.monotonic() - started
            finally:
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()


def summary(seconds: list[float]) -> str:
    return (
        f"launch-to-first-frame runs={len(seconds)} "
        f"min={min(seconds):.3f}s median={statistics.median(seconds):.3f}s max={max(seconds):.3f}s"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("--runs", type=int, default=5)
    arguments = parser.parse_args()
    binary = arguments.binary.resolve(strict=True)
    launch_once(binary)
    seconds = []
    for run in range(1, arguments.runs + 1):
        seconds.append(launch_once(binary))
        print(f"launch-to-first-frame run={run} seconds={seconds[-1]:.3f}")
    print(summary(seconds))


if __name__ == "__main__":
    main()
