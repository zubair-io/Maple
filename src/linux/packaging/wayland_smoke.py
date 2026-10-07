#!/usr/bin/env python3
"""Verify an unpacked Maple Wayland toplevel and committed content buffer (#4317)."""

import argparse
import os
import re
import subprocess
import tempfile
import time
from pathlib import Path


def surface_evidence(log: str) -> str | None:
    """Follow the app's own xdg object chain, rather than Mesa query callbacks."""
    for toplevel in re.findall(
        r'xdg_toplevel[#@](\d+)\.set_app_id\("app\.justmaple\.aperture"\)', log
    ):
        title = re.search(rf'xdg_toplevel[#@]{toplevel}\.set_title\("Maple"\)', log)
        parent = re.search(
            rf"xdg_surface[#@](\d+)\.get_toplevel\(new id xdg_toplevel[#@]{toplevel}\)",
            log,
        )
        if title is None or parent is None:
            continue
        xdg = parent[1]
        source = re.search(
            rf"get_xdg_surface\(new id xdg_surface[#@]{xdg}, wl_surface[#@](\d+)\)", log
        )
        if source is None:
            continue
        surface = source[1]
        geometry = re.findall(
            rf"xdg_surface[#@]{xdg}\.set_window_geometry\(-?\d+, -?\d+, (\d+), (\d+)\)",
            log,
        )
        configured = any(
            (int(w) >= 800 and int(h) >= 540)
            or (
                (int(w) == 0 or int(h) == 0)
                and any(
                    (int(w) or int(gw)) >= 800 and (int(h) or int(gh)) >= 540
                    for gw, gh in geometry
                )
            )
            for w, h in re.findall(
                rf"xdg_toplevel[#@]{toplevel}\.configure\((\d+), (\d+),", log
            )
        )
        acknowledged = re.search(rf"xdg_surface[#@]{xdg}\.ack_configure\(\d+\)", log)
        attached = re.search(
            rf"wl_surface[#@]{surface}\.attach\(wl_buffer[#@]\d+, 0, 0\)", log
        )
        committed = attached and re.search(
            rf"wl_surface[#@]{surface}\.commit\(\)", log[attached.end() :]
        )
        if configured and acknowledged and committed:
            return (
                f"Maple xdg_toplevel#{toplevel}, wl_surface#{surface}: "
                "configured/declared >=800x540, acknowledged, non-null content buffer committed."
            )
    return None


def inspect(binary: Path) -> None:
    if not os.environ.get("WAYLAND_DISPLAY") or not os.environ.get("XDG_RUNTIME_DIR"):
        raise RuntimeError("This check requires a live Wayland desktop session")
    with tempfile.TemporaryDirectory(prefix="maple-wayland-smoke-") as directory:
        root = Path(directory)
        photos = root / "photos"
        photos.mkdir()
        environment = os.environ.copy()
        environment.pop("DISPLAY", None)
        environment["WAYLAND_DEBUG"] = "client"
        with (root / "launch.log").open("w+") as log:
            process = subprocess.Popen(
                [str(binary), str(photos)],
                cwd=root,
                env=environment,
                stdout=log,
                stderr=log,
            )
            try:
                deadline = time.monotonic() + 30
                evidence = None
                while time.monotonic() < deadline:
                    if process.poll() is not None:
                        log.seek(0)
                        raise RuntimeError(
                            f"Maple exited with {process.returncode}: {log.read()}"
                        )
                    log.seek(0)
                    evidence = surface_evidence(log.read())
                    if evidence:
                        break
                    time.sleep(0.1)
                if evidence is None:
                    log.seek(0)
                    raise RuntimeError(
                        f"No committed Maple Wayland toplevel: {log.read()}"
                    )
                time.sleep(2)
                if process.poll() is not None:
                    raise RuntimeError(
                        "Maple exited after committing its Wayland content"
                    )
                print(evidence)
                print(
                    f"PID {process.pid} stays live outside the checkout; DISPLAY is unset."
                )
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
