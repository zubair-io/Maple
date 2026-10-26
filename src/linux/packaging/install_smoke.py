#!/usr/bin/env python3
"""Install, diagnose, launch, update and remove one Maple package in a clean,
disposable root container (#5449). It runs apt-get, so never run it on a desktop."""

import argparse
import os
import re
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

APP_ID = "app.justmaple.aperture"
PACKAGING = Path(__file__).resolve().parent
PHOTO = (
    PACKAGING.parents[2]
    / "src/apple/MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng"
)
TEST_TOOLS = ["xvfb", "xauth", "x11-utils", "weston"]
APPIMAGE_RUNTIME = [
    "libvulkan1",
    "mesa-vulkan-drivers",
    "libwayland-client0",
    "libxkbcommon0",
    "libxkbcommon-x11-0",
    "libx11-6",
    "libx11-xcb1",
    "libxcb1",
    "libxcursor1",
    "libxi6",
    "libxrandr2",
]


def run(*command: str, env: dict | None = None, cwd: Path | None = None) -> str:
    print("+", " ".join(command), flush=True)
    result = subprocess.run(
        command, env=env, cwd=cwd, text=True, stdout=subprocess.PIPE, check=False
    )
    print(result.stdout, end="", flush=True)
    if result.returncode:
        raise RuntimeError(f"{command[0]} exited with {result.returncode}")
    return result.stdout


def apt(*arguments: str, cwd: Path | None = None) -> None:
    run(
        "apt-get",
        "-y",
        *arguments,
        env={**os.environ, "DEBIAN_FRONTEND": "noninteractive"},
        cwd=cwd,
    )


def headless(env: dict) -> dict:
    return {
        key: value
        for key, value in env.items()
        if key not in {"DISPLAY", "WAYLAND_DISPLAY"}
    }


def diagnose_problems(binary: Path, env: dict) -> set[str]:
    result = subprocess.run(
        [str(binary), "--diagnose"],
        check=False,
        env=env,
        text=True,
        capture_output=True,
    )
    print(result.stdout, result.stderr, sep="", flush=True)
    problems = set(re.findall(r"^\[problem\] (\w+):", result.stdout, re.MULTILINE))
    if result.returncode != (1 if problems else 0):
        raise RuntimeError(f"--diagnose exited {result.returncode} for {problems}")
    for private in [env.get("HOME", ""), str(PHOTO)]:
        if private and private in result.stdout:
            raise RuntimeError("--diagnose printed a private path")
    return problems


def expect_problems(binary: Path, env: dict, expected: set[str]) -> None:
    found = diagnose_problems(binary, headless(env))
    if found != expected:
        raise RuntimeError(
            f"--diagnose found {sorted(found)}, expected {sorted(expected)}"
        )


def default_handler(mime_type: str, env: dict) -> str:
    output = run("gio", "mime", mime_type, env={**env, "LC_ALL": "C.UTF-8"})
    return next(
        (
            line
            for line in output.splitlines()
            if line.startswith("Default application")
        ),
        "",
    )


def check_associations(data_dir: Path, env: dict) -> None:
    desktop = data_dir / f"applications/{APP_ID}.desktop"
    run("desktop-file-validate", str(desktop))
    mime_types = (
        next(
            line.removeprefix("MimeType=")
            for line in desktop.read_text().splitlines()
            if line.startswith("MimeType=")
        )
        .rstrip(";")
        .split(";")
    )
    globs = (data_dir / "mime/globs2").read_text()
    own = re.findall(
        r'<mime-type type="([^"]+)">.*?<glob pattern="([^"]+)"/>',
        (data_dir / f"mime/packages/{APP_ID}.xml").read_text(),
        re.DOTALL,
    )
    for mime_type, glob in own:
        if not re.search(
            rf"^\d+:{re.escape(mime_type)}:{re.escape(glob)}$", globs, re.MULTILINE
        ):
            raise RuntimeError(f"{glob} is not registered as {mime_type}")
    for mime_type in mime_types:
        if f"{APP_ID}.desktop" not in default_handler(mime_type, env):
            raise RuntimeError(f"Maple is not the default handler for {mime_type}")
    print(f"Maple handles {len(mime_types)} MIME types, {len(own)} declared by Maple.")


def check_removed(paths: list[Path], data_dir: Path, env: dict) -> None:
    left = [path for path in paths if path.exists() or path.is_symlink()]
    if left:
        raise RuntimeError(f"Removal left {left}")
    globs = data_dir / "mime/globs2"
    if globs.exists() and "image/x-samsung-srw" in globs.read_text():
        raise RuntimeError("Removal left Maple's MIME types registered")
    if APP_ID in default_handler("image/x-adobe-dng", env):
        raise RuntimeError("Removal left Maple as the DNG handler")


def launch(binary: Path, sessions: list[str], env: dict) -> None:
    if "x11" in sessions:
        run(
            "xvfb-run",
            "-a",
            "-s",
            "-screen 0 1280x800x24",
            "python3",
            str(PACKAGING / "smoke.py"),
            str(binary),
            env=headless(env),
        )
    if "wayland" in sessions:
        run(
            "python3",
            str(PACKAGING / "weston_smoke.py"),
            str(binary),
            env=headless(env),
        )


def open_with(desktop: Path, binary: Path, env: dict) -> None:
    """Launch through the installed desktop entry, as a file manager would."""
    with tempfile.TemporaryDirectory(prefix="maple open with ") as directory:
        photo = Path(directory) / "grey.dng"
        shutil.copyfile(PHOTO, photo)
        server = subprocess.Popen(["Xvfb", ":71", "-screen", "0", "1280x800x24"])
        launched = None
        try:
            time.sleep(1)
            run(
                "gio",
                "launch",
                str(desktop),
                str(photo),
                env={**headless(env), "DISPLAY": ":71"},
            )
            deadline = time.monotonic() + 20
            while launched is None and time.monotonic() < deadline:
                launched = next(
                    (
                        process
                        for process in Path("/proc").iterdir()
                        if process.name.isdigit() and is_launch(process, binary, photo)
                    ),
                    None,
                )
                time.sleep(0.2)
            if launched is None:
                raise RuntimeError("Open With did not start Maple with the photo")
            print(f"Open With started PID {launched.name} on the photo.")
        finally:
            if launched is not None:
                subprocess.run(["kill", launched.name], check=False)
            server.terminate()
            server.wait(timeout=10)


def is_launch(process: Path, binary: Path, photo: Path) -> bool:
    try:
        arguments = (process / "cmdline").read_bytes().split(b"\0")
        executable = Path(os.readlink(process / "exe"))
    except OSError:
        return False
    return executable == binary.resolve() and os.fsencode(photo) in arguments


def smoke_deb(package: Path, sessions: list[str]) -> None:
    env = dict(os.environ)
    binary = Path("/usr/bin/maple-linux")
    apt("install", f"./{package.name}", cwd=package.parent)
    expect_problems(binary, env, {"session", "portal"})
    apt("install", "--no-install-recommends", *TEST_TOOLS)
    check_associations(Path("/usr/share"), env)
    launch(binary, sessions, env)
    open_with(Path(f"/usr/share/applications/{APP_ID}.desktop"), binary, env)
    apt("install", "--reinstall", f"./{package.name}", cwd=package.parent)
    check_associations(Path("/usr/share"), env)
    apt("purge", "maple")
    check_removed(
        [
            binary,
            Path(f"/usr/share/applications/{APP_ID}.desktop"),
            Path(f"/usr/share/icons/hicolor/512x512/apps/{APP_ID}.png"),
            Path(f"/usr/share/mime/packages/{APP_ID}.xml"),
        ],
        Path("/usr/share"),
        env,
    )


def smoke_appimage(package: Path, sessions: list[str]) -> None:
    home = Path(tempfile.mkdtemp(prefix="maple home "))
    env = {
        key: value for key, value in os.environ.items() if not key.startswith("XDG_")
    } | {"HOME": str(home)}
    installer = str(PACKAGING / "install-maple-appimage.sh")
    target = home / ".local/opt/maple-appimage"
    binary = target / "usr/bin/maple-linux"
    data_dir = home / ".local/share"
    run("bash", installer, str(package), env=env)
    expect_problems(binary, env, {"vulkan", "session", "libraries", "portal"})
    apt("install", "--no-install-recommends", *APPIMAGE_RUNTIME, *TEST_TOOLS)
    expect_problems(binary, env, {"session", "portal"})
    check_associations(data_dir, env)
    launch(binary, sessions, env)
    open_with(data_dir / f"applications/{APP_ID}.desktop", binary, env)
    run("bash", installer, str(package), env=env)
    check_associations(data_dir, env)
    run("bash", str(target / "install-maple-appimage.sh"), "--uninstall", env=env)
    check_removed(
        [
            target,
            data_dir / f"applications/{APP_ID}.desktop",
            data_dir / f"icons/hicolor/512x512/apps/{APP_ID}.png",
            data_dir / f"mime/packages/{APP_ID}.xml",
        ],
        data_dir,
        env,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("format", choices=["deb", "appimage"])
    parser.add_argument("package", type=Path)
    parser.add_argument("--sessions", default="x11,wayland")
    args = parser.parse_args()
    in_container = Path("/.dockerenv").exists() or Path("/run/.containerenv").exists()
    if os.geteuid() != 0 or not in_container:
        raise SystemExit("Run this only as root in a disposable container")
    sessions = args.sessions.split(",")
    package = args.package.resolve(strict=True)
    (smoke_deb if args.format == "deb" else smoke_appimage)(package, sessions)
    print(f"{args.format} install, launch, update and removal passed.")


if __name__ == "__main__":
    main()
