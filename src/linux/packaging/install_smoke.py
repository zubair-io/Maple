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

from package import DEB_RUNTIME_DEPENDS

APP_ID = "app.justmaple.aperture"
PACKAGING = Path(__file__).resolve().parent
PHOTO = (
    PACKAGING.parents[2]
    / "src/apple/MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng"
)
TEST_TOOLS = ["xvfb", "xauth", "x11-utils", "weston"]
APPIMAGE_RUNTIME = [*DEB_RUNTIME_DEPENDS, "mesa-vulkan-drivers"]
FLATPAK_TOOLS = ["flatpak", "ostree"]


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
    """Without a display; the picker is a problem only without the zenity fallback."""
    expected = expected | (
        {"session"} if shutil.which("zenity") else {"session", "portal"}
    )
    found = diagnose_problems(binary, headless(env))
    if found != expected:
        raise RuntimeError(
            f"--diagnose found {sorted(found)}, expected {sorted(expected)}"
        )


def handlers(mime_type: str, env: dict) -> str:
    return run("gio", "mime", mime_type, env={**env, "LC_ALL": "C.UTF-8"})


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
        if f"{APP_ID}.desktop" not in handlers(mime_type, env):
            raise RuntimeError(f"Maple is not registered for {mime_type}")
    print(f"Maple handles {len(mime_types)} MIME types, {len(own)} declared by Maple.")


def check_removed(paths: list[Path], data_dir: Path, env: dict) -> None:
    left = [path for path in paths if path.exists() or path.is_symlink()]
    if left:
        raise RuntimeError(f"Removal left {left}")
    globs = data_dir / "mime/globs2"
    if globs.exists() and "image/x-samsung-srw" in globs.read_text():
        raise RuntimeError("Removal left Maple's MIME types registered")
    if APP_ID in handlers("image/x-adobe-dng", env):
        raise RuntimeError("Removal left Maple registered for DNG")


def check_try_exec(desktop: Path, binary: Path) -> None:
    lines = [
        line.removeprefix("TryExec=")
        for line in desktop.read_text().splitlines()
        if line.startswith("TryExec=")
    ]
    if lines != [str(binary)] or not os.access(binary, os.X_OK):
        raise RuntimeError(f"TryExec {lines} does not name the installed {binary}")


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
        try:
            deadline = time.monotonic() + 20
            while not Path("/tmp/.X11-unix/X71").is_socket():
                if server.poll() is not None or time.monotonic() > deadline:
                    raise RuntimeError("Xvfb did not start")
                time.sleep(0.1)
            # Not run(): Maple inherits gio's stdout, so a captured pipe would
            # never reach EOF while Maple is still running.
            command = ["gio", "launch", str(desktop), str(photo)]
            print("+", " ".join(command), flush=True)
            subprocess.run(
                command,
                env={**headless(env), "DISPLAY": ":71"},
                stdin=subprocess.DEVNULL,
                check=True,
                timeout=60,
            )
            deadline = time.monotonic() + 20
            while not (launched := launches(binary, photo)):
                if time.monotonic() > deadline:
                    raise RuntimeError("Open With did not start Maple with the photo")
                time.sleep(0.2)
            print(f"Open With started PID {launched[0].name} on the photo.")
        finally:
            # A stray Maple would hold the step's stdout open, so it is killed
            # even when the launch check failed part-way.
            for process in launches(binary, photo):
                subprocess.run(["kill", "-KILL", process.name], check=False)
            server.terminate()
            try:
                server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()


def launches(binary: Path, photo: Path) -> list[Path]:
    return [
        process
        for process in Path("/proc").iterdir()
        if process.name.isdigit() and is_launch(process, binary, photo)
    ]


def is_launch(process: Path, binary: Path, photo: Path) -> bool:
    try:
        arguments = (process / "cmdline").read_bytes().split(b"\0")
        executable = Path(os.readlink(process / "exe"))
    except OSError:
        return False
    return executable == binary.resolve() and os.fsencode(photo) in arguments


def previous_version(package: Path, directory: Path) -> Path:
    """The same package relabelled as an older version, to exercise an upgrade."""
    tree = directory / "previous"
    run("dpkg-deb", "-R", str(package), str(tree))
    control = tree / "DEBIAN/control"
    control.write_text(
        re.sub(
            r"^Version: (.+)$",
            r"Version: \1~previous",
            control.read_text(),
            flags=re.MULTILINE,
        )
    )
    output = directory / "maple-previous.deb"
    run("dpkg-deb", "--root-owner-group", "-b", str(tree), str(output))
    return output


def smoke_deb(package: Path, sessions: list[str]) -> None:
    env = dict(os.environ)
    binary = Path("/usr/bin/maple-linux")
    with tempfile.TemporaryDirectory(prefix="maple-deb-") as directory:
        previous = previous_version(package, Path(directory))
        apt("install", f"./{previous.name}", cwd=previous.parent)
    apt("install", f"./{package.name}", cwd=package.parent)
    installed = run("dpkg-query", "-W", "-f=${Version}", "maple")
    if "~previous" in installed:
        raise RuntimeError(f"Upgrade left version {installed}")
    expect_problems(binary, env, set())
    apt("install", "--no-install-recommends", *TEST_TOOLS)
    check_associations(Path("/usr/share"), env)
    launch(binary, sessions, env)
    open_with(Path(f"/usr/share/applications/{APP_ID}.desktop"), binary, env)
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


def failed_update(installer: str, package: Path, env: dict, expected: str) -> None:
    result = subprocess.run(
        ["bash", installer, str(package)],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    print(result.stdout, result.stderr, sep="", flush=True)
    if result.returncode == 0:
        raise RuntimeError("An update that should have failed succeeded")
    if expected not in result.stderr:
        raise RuntimeError(f"The failed update did not report: {expected}")


def check_kept_install(target: Path, marker_inode: int) -> None:
    if (target / ".maple-appimage-install").stat().st_ino != marker_inode:
        raise RuntimeError("A failed update did not keep the existing installation")
    if [path for path in target.parent.glob(".maple-appimage.*") if path.is_dir()]:
        raise RuntimeError("A failed update left a working directory behind")


def check_blocked_destination(
    installer: str, package: Path, desktop: Path, target: Path, env: dict
) -> None:
    entry = desktop.read_text()
    marker_inode = (target / ".maple-appimage-install").stat().st_ino
    desktop.unlink()
    desktop.mkdir()
    (desktop / "keep").write_text("user data\n")
    failed_update(installer, package, env, "Refusing to replace the directory")
    if (desktop / "keep").read_text() != "user data\n":
        raise RuntimeError("Installer changed the directory it refused to replace")
    check_kept_install(target, marker_inode)
    shutil.rmtree(desktop)
    desktop.write_text(entry)


def check_rollback(
    installer: str, package: Path, integration: list[Path], target: Path, env: dict
) -> None:
    originals = {path: path.read_bytes() for path in integration}
    marked = {path: content + b"\n" for path, content in originals.items()}
    for path, content in marked.items():
        path.write_bytes(content)
    marker_inode = (target / ".maple-appimage-install").stat().st_ino
    shims = Path(tempfile.mkdtemp(prefix="maple-shims-"))
    chmod = shims / "chmod"
    chmod.write_text(
        "#!/bin/sh\n"
        'for last; do :; done\n'
        'case $last in */applications/.maple.*) exit 1 ;; esac\n'
        'exec /usr/bin/chmod "$@"\n'
    )
    chmod.chmod(0o755)
    failing = env | {"PATH": f"{shims}:{env.get('PATH', os.defpath)}"}
    failed_update(installer, package, failing, "the previous state was restored")
    check_kept_install(target, marker_inode)
    if [path for path, content in marked.items() if path.read_bytes() != content]:
        raise RuntimeError("A rolled-back update did not restore integration files")
    if list(integration[-1].parent.glob(".maple.*")):
        raise RuntimeError("A rolled-back update left a staged file behind")
    shutil.rmtree(shims)
    for path, content in originals.items():
        path.write_bytes(content)


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
    expect_problems(binary, env, {"vulkan", "libraries"})
    apt("install", "--no-install-recommends", *APPIMAGE_RUNTIME, *TEST_TOOLS)
    expect_problems(binary, env, set())
    check_associations(data_dir, env)
    check_try_exec(data_dir / f"applications/{APP_ID}.desktop", binary)
    launch(binary, sessions, env)
    open_with(data_dir / f"applications/{APP_ID}.desktop", binary, env)
    installed_installer = str(target / "install-maple-appimage.sh")
    run("bash", installed_installer, str(package), env=env)
    check_associations(data_dir, env)
    desktop = data_dir / f"applications/{APP_ID}.desktop"
    check_try_exec(desktop, binary)
    check_blocked_destination(installed_installer, package, desktop, target, env)
    check_rollback(
        installed_installer,
        package,
        [
            data_dir / f"icons/hicolor/512x512/apps/{APP_ID}.png",
            data_dir / f"mime/packages/{APP_ID}.xml",
            desktop,
        ],
        target,
        env,
    )
    edited = desktop.read_text() + "X-Edited-By-User=true\n"
    desktop.write_text(edited)
    run("bash", installed_installer, "--uninstall", env=env)
    if not desktop.exists() or desktop.read_text() != edited:
        raise RuntimeError("Uninstall removed a desktop entry the user had changed")
    desktop.unlink()
    check_removed(
        [
            target,
            desktop,
            data_dir / f"icons/hicolor/512x512/apps/{APP_ID}.png",
            data_dir / f"mime/packages/{APP_ID}.xml",
        ],
        data_dir,
        env,
    )


def newer_bundle(package: Path, ref: str, directory: Path) -> Path:
    """The same build recommitted on top of itself, so installing it is an update."""
    repo = directory / "repo"
    run("ostree", f"--repo={repo}", "init", "--mode=archive")
    run("flatpak", "build-import-bundle", str(repo), str(package))
    run(
        "flatpak",
        "build-commit-from",
        "--force",
        f"--src-ref={ref}",
        "--subject=Maple smoke update",
        str(repo),
        ref,
    )
    output = directory / "maple-newer.flatpak"
    _, _, architecture, branch = ref.split("/")
    run(
        "flatpak",
        "build-bundle",
        f"--arch={architecture}",
        str(repo),
        str(output),
        APP_ID,
        branch,
    )
    return output


def flatpak(command: str, *arguments: str, env: dict) -> str:
    return run("flatpak", command, "--user", *arguments, env=env)


def expect_sandbox_problems(launcher: Path, env: dict) -> None:
    """Headless and without a session bus; the runtime has no zenity fallback."""
    found = diagnose_problems(launcher, headless(env))
    if found != {"session", "portal"}:
        raise RuntimeError(f"--diagnose in the sandbox found {sorted(found)}")


def smoke_flatpak(package: Path, sessions: list[str]) -> None:
    home = Path.home()
    exports = home / ".local/share/flatpak/exports/share"
    # The sandbox has a private /tmp; photos the smokes open must live in home.
    tempfile.tempdir = str(home / "maple-smoke-tmp")
    Path(tempfile.tempdir).mkdir()
    env = {
        key: value for key, value in os.environ.items() if not key.startswith("XDG_")
    } | {
        "TMPDIR": tempfile.tempdir,
        "XDG_RUNTIME_DIR": tempfile.mkdtemp(prefix="maple-runtime-"),
        "XDG_DATA_DIRS": f"{exports}:/usr/local/share:/usr/share",
    }
    install = ["--noninteractive", "-y", "--bundle"]
    apt("install", "--no-install-recommends", *FLATPAK_TOOLS, *TEST_TOOLS)
    flatpak("install", *install, str(package), env=env)
    ref = flatpak("info", "--show-ref", APP_ID, env=env).strip()
    launcher = home / "maple-flatpak"
    launcher.write_text(f'#!/bin/sh\nexec flatpak run --user {APP_ID} "$@"\n')
    launcher.chmod(0o755)
    expect_sandbox_problems(launcher, env)
    desktop = exports / f"applications/{APP_ID}.desktop"
    check_associations(exports, env)
    launch(launcher, sessions, env)
    # /proc reports a sandboxed executable at its path inside the sandbox.
    open_with(desktop, Path("/app/bin/maple-linux"), env)
    installed = flatpak("info", "--show-commit", APP_ID, env=env)
    with tempfile.TemporaryDirectory(prefix="maple-flatpak-") as directory:
        newer = newer_bundle(package, ref, Path(directory))
        flatpak("install", *install, str(newer), env=env)
    if flatpak("info", "--show-commit", APP_ID, env=env) == installed:
        raise RuntimeError("Installing the newer bundle did not update Maple")
    expect_sandbox_problems(launcher, env)
    check_associations(exports, env)
    flatpak("uninstall", "--noninteractive", "-y", "--delete-data", APP_ID, env=env)
    if f"{APP_ID}-origin" in flatpak("remotes", env=env):
        raise RuntimeError("Uninstall left the bundle's origin remote")
    check_removed(
        [
            home / f".local/share/flatpak/app/{APP_ID}",
            home / f".var/app/{APP_ID}",
            desktop,
            exports / f"icons/hicolor/512x512/apps/{APP_ID}.png",
            exports / f"mime/packages/{APP_ID}.xml",
        ],
        exports,
        env,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("format", choices=["deb", "appimage", "flatpak"])
    parser.add_argument("package", type=Path)
    parser.add_argument("--sessions", default="x11,wayland")
    args = parser.parse_args()
    in_container = Path("/.dockerenv").exists() or Path("/run/.containerenv").exists()
    if os.geteuid() != 0 or not in_container:
        raise SystemExit("Run this only as root in a disposable container")
    sessions = args.sessions.split(",")
    package = args.package.resolve(strict=True)
    smokes = {"deb": smoke_deb, "appimage": smoke_appimage, "flatpak": smoke_flatpak}
    smokes[args.format](package, sessions)
    print(f"{args.format} install, launch, update and removal passed.")


if __name__ == "__main__":
    main()
