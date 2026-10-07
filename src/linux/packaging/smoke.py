#!/usr/bin/env python3
"""Require a live X11 window from the unpacked Maple executable (#4317)."""
import argparse
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time


def inspect(binary: Path) -> None:
    with tempfile.TemporaryDirectory(prefix="maple-package-smoke-") as directory:
        root = Path(directory)
        photos = root / "photos"
        photos.mkdir()
        with (root / "launch.log").open("w+") as log:
            environment = os.environ.copy()
            environment.pop("WAYLAND_DISPLAY", None)
            process = subprocess.Popen(
                [str(binary), str(photos)], cwd=root, env=environment, stdout=log, stderr=log
            )
            try:
                deadline = time.monotonic() + 30
                window = None
                while time.monotonic() < deadline:
                    if process.poll() is not None:
                        log.seek(0)
                        raise RuntimeError(f"Maple exited with {process.returncode}: {log.read()}")
                    tree = subprocess.run(
                        ["xwininfo", "-root", "-tree"], text=True, capture_output=True
                    )
                    if tree.returncode:
                        time.sleep(0.1)
                        continue
                    for line in tree.stdout.splitlines():
                        match = re.search(r'(0x[0-9a-f]+) "Maple".*?\s(\d+)x(\d+)\+', line)
                        if not match or int(match[2]) < 800 or int(match[3]) < 540:
                            continue
                        queried = subprocess.run(
                            ["xprop", "-id", match[1], "_NET_WM_PID", "WM_CLASS"],
                            text=True, capture_output=True,
                        )
                        if queried.returncode:
                            continue
                        properties = queried.stdout
                        pid = re.search(r"_NET_WM_PID\(CARDINAL\) = (\d+)", properties)
                        if pid and int(pid[1]) == process.pid and '"app.justmaple.aperture"' in properties:
                            window = (line.strip(), properties.strip())
                            break
                    if window:
                        break
                    time.sleep(0.1)
                if window is None:
                    log.seek(0)
                    raise RuntimeError(f"No Maple application window: {log.read()}")
                time.sleep(2)
                if process.poll() is not None:
                    raise RuntimeError("Maple exited after creating its window")
                print("\n".join(window))
                print("Executable stays live outside the checkout.")
            finally:
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    inspect(parser.parse_args().binary.resolve(strict=True))


if __name__ == "__main__":
    main()
