#!/usr/bin/env python3
"""Require a live X11 window from the unpacked Maple executable (#4317)."""
import argparse
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time


def read(path: Path) -> str:
    try:
        return path.read_text()
    except OSError:
        return ""


def namespaced_pids(root: int) -> set[int]:
    """PIDs of root and its descendants as each process sees itself, so a window
    from an app in its own PID namespace (Flatpak) still matches its launcher."""
    parents = {
        int(entry.name): int(stat.rsplit(")", 1)[1].split()[1])
        for entry in Path("/proc").iterdir()
        if entry.name.isdigit() and (stat := read(entry / "stat"))
    }
    tree = {root}
    while grown := {pid for pid, parent in parents.items() if parent in tree} - tree:
        tree |= grown
    return {
        int(nspid[1].split()[-1])
        if (nspid := re.search(r"^NSpid:\s+(.+)$", read(Path(f"/proc/{pid}/status")), re.MULTILINE))
        else pid
        for pid in tree
    }


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
                    launched = namespaced_pids(process.pid)
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
                        if pid and int(pid[1]) in launched and '"app.justmaple.aperture"' in properties:
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
