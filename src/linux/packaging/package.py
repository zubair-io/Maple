#!/usr/bin/env python3
"""Build the Maple Linux .deb or AppImage from a release executable (#5449)."""

import argparse
import hashlib
import os
import shutil
import struct
import subprocess
import tempfile
import tomllib
from pathlib import Path

APP_ID = "app.justmaple.aperture"
LINUX = Path(__file__).resolve().parents[1]
ROOT = LINUX.parents[1]
ICON = ROOT / "src/apple/Maple/Assets.xcassets/AppIcon.appiconset/maple512.png"
DEB_ARCHITECTURES = {"x86_64": "amd64", "aarch64": "arm64"}
# Loaded with dlopen, so dpkg-shlibdeps cannot see them.
DEB_RUNTIME_DEPENDS = [
    "libvulkan1",
    "libxkbcommon0",
    "libwayland-client0",
    "libx11-6",
    "libx11-xcb1",
    "libxcb1",
    "libxcursor1",
    "libxi6",
    "libxrandr2",
    "libxkbcommon-x11-0",
]
DEB_RECOMMENDS = "mesa-vulkan-drivers | vulkan-icd, xdg-desktop-portal"
# AppImage type2-runtime release 20251108, pinned by content.
APPIMAGE_RUNTIME_SHA256 = {
    "x86_64": "2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d",
}


def binary_architecture(binary: Path) -> str:
    with binary.open("rb") as source:
        header = source.read(20)
    if len(header) != 20 or header[:4] != b"\x7fELF" or header[5] not in (1, 2):
        raise ValueError("The package requires a Linux ELF executable")
    machine = struct.unpack("<H" if header[5] == 1 else ">H", header[18:20])[0]
    architectures = {62: "x86_64", 183: "aarch64"}
    if header[4] != 2 or machine not in architectures:
        raise ValueError("Packaging supports x86_64 and aarch64 Linux executables")
    return architectures[machine]


def version() -> str:
    with (LINUX / "Cargo.toml").open("rb") as source:
        return tomllib.load(source)["package"]["version"]


def sha256(path: Path) -> str:
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def stage_usr(binary: Path, root: Path) -> None:
    """The /usr tree shared by both formats."""
    files = {
        "usr/bin/maple-linux": binary,
        f"usr/share/applications/{APP_ID}.desktop": LINUX
        / f"packaging/{APP_ID}.desktop",
        f"usr/share/icons/hicolor/512x512/apps/{APP_ID}.png": ICON,
        f"usr/share/mime/packages/{APP_ID}.xml": LINUX / f"packaging/{APP_ID}.xml",
    }
    for relative, source in files.items():
        destination = root / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)
        destination.chmod(0o755 if relative.startswith("usr/bin/") else 0o644)
    for directory in [root, *root.rglob("*")]:
        if directory.is_dir():
            directory.chmod(0o755)


def shlib_depends(binary: Path, work: Path) -> str:
    (work / "debian/control").write_text(
        "Source: maple\n\nPackage: maple\nArchitecture: any\n"
    )
    result = subprocess.run(
        ["dpkg-shlibdeps", "-O", f"-e{binary.relative_to(work)}"],
        cwd=work,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"dpkg-shlibdeps failed:\n{result.stderr}")
    prefix = "shlibs:Depends="
    depends = next(
        (
            line.removeprefix(prefix)
            for line in result.stdout.splitlines()
            if line.startswith(prefix)
        ),
        None,
    )
    if depends is None:
        raise RuntimeError(f"dpkg-shlibdeps found no library dependencies for {binary}")
    return depends


def build_deb(binary: Path, output_dir: Path) -> Path:
    architecture = DEB_ARCHITECTURES[binary_architecture(binary)]
    output = output_dir / f"maple_{version()}_{architecture}.deb"
    if output.exists():
        raise FileExistsError(output)
    with tempfile.TemporaryDirectory(prefix="maple-deb-") as directory:
        work = Path(directory)
        root = work / "debian/maple"
        stage_usr(binary, root)
        installed_kib = sum(
            -(-path.stat().st_size // 1024)
            for path in root.rglob("*")
            if path.is_file()
        )
        depends = ", ".join(
            [shlib_depends(root / "usr/bin/maple-linux", work), *DEB_RUNTIME_DEPENDS]
        )
        control = root / "DEBIAN/control"
        control.parent.mkdir(mode=0o755)
        control.parent.chmod(0o755)
        control.write_text(
            "\n".join(
                [
                    "Package: maple",
                    f"Version: {version()}",
                    f"Architecture: {architecture}",
                    "Maintainer: Just Maple <help@justmaple.app>",
                    f"Installed-Size: {installed_kib}",
                    f"Depends: {depends}",
                    f"Recommends: {DEB_RECOMMENDS}",
                    "Section: graphics",
                    "Priority: optional",
                    "Homepage: https://mapleeditor.com/",
                    "Description: Non-destructive RAW photo editor",
                    " Maple edits camera RAW and image files without modifying the",
                    " originals; every edit is stored in an XMP sidecar.",
                    "",
                ]
            )
        )
        control.chmod(0o644)
        subprocess.run(
            ["dpkg-deb", "--root-owner-group", "--build", str(root), str(output)],
            check=True,
        )
    return output


def build_appimage(binary: Path, runtime: Path, output_dir: Path) -> Path:
    architecture = binary_architecture(binary)
    expected = APPIMAGE_RUNTIME_SHA256.get(architecture)
    if expected is None or sha256(runtime) != expected:
        raise ValueError(f"{runtime} is not the pinned {architecture} AppImage runtime")
    output = output_dir / f"Maple-{version()}-{architecture}.AppImage"
    with tempfile.TemporaryDirectory(prefix="maple-appimage-") as directory:
        work = Path(directory)
        app_dir = work / "Maple.AppDir"
        stage_usr(binary, app_dir)
        shutil.copyfile(
            LINUX / f"packaging/{APP_ID}.desktop", app_dir / f"{APP_ID}.desktop"
        )
        shutil.copyfile(ICON, app_dir / f"{APP_ID}.png")
        (app_dir / ".DirIcon").symlink_to(f"{APP_ID}.png")
        (app_dir / "AppRun").symlink_to("usr/bin/maple-linux")
        installer = app_dir / "install-maple-appimage.sh"
        shutil.copyfile(LINUX / "packaging/install-maple-appimage.sh", installer)
        installer.chmod(0o755)
        image = work / "payload.squashfs"
        subprocess.run(
            [
                "mksquashfs",
                str(app_dir),
                str(image),
                "-root-owned",
                "-noappend",
                "-comp",
                "zstd",
                "-quiet",
            ],
            check=True,
        )
        with output.open("xb") as appimage:
            for part in (runtime, image):
                with part.open("rb") as source:
                    shutil.copyfileobj(source, appimage)
        output.chmod(0o755)
    return output


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("format", choices=["deb", "appimage"])
    parser.add_argument(
        "--binary", type=Path, default=LINUX / "target/release/maple-linux"
    )
    parser.add_argument("--runtime", type=Path, help="AppImage type2 runtime")
    parser.add_argument("--output-dir", type=Path, default=Path.cwd())
    args = parser.parse_args()
    binary = args.binary.resolve(strict=True)
    if not os.access(binary, os.X_OK):
        raise ValueError(f"{binary} is not executable; build Maple with cargo first")
    if args.format == "appimage" and args.runtime is None:
        parser.error("appimage requires --runtime")
    output_dir = args.output_dir.resolve(strict=True)
    artifact = (
        build_deb(binary, output_dir)
        if args.format == "deb"
        else build_appimage(binary, args.runtime.resolve(strict=True), output_dir)
    )
    checksum = artifact.with_name(f"{artifact.name}.sha256")
    with checksum.open("x") as record:
        record.write(f"{sha256(artifact)}  {artifact.name}\n")
    print(artifact)


if __name__ == "__main__":
    main()
