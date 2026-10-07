#!/usr/bin/env python3
"""Package a built Linux host and canonical Maple icon for a local-prefix install."""
import argparse
import os
from pathlib import Path
import shutil
import struct
import tarfile
import tempfile
import tomllib


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


def package(binary: Path, output: Path) -> None:
    root = Path(__file__).resolve().parents[3]
    if not binary.is_file() or not os.access(binary, os.X_OK):
        raise ValueError(f"Executable not found: {binary}; build Maple with cargo first")
    binary_architecture(binary)
    with tempfile.TemporaryDirectory(prefix="maple-package-") as directory:
        stage = Path(directory)
        files = {
            "bin/maple-linux": binary,
            "share/applications/app.justmaple.aperture.desktop": Path(__file__).with_name(
                "app.justmaple.aperture.desktop"
            ),
            "share/icons/hicolor/512x512/apps/app.justmaple.aperture.png": root
            / "src/apple/Maple/Assets.xcassets/AppIcon.appiconset/maple512.png",
        }
        for relative, source in files.items():
            destination = stage / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, destination)
            destination.chmod(0o755 if relative.startswith("bin/") else 0o644)
        # Exclusive creation avoids replacing an existing release artifact.
        with tarfile.open(output, "x:gz") as archive:
            for path in sorted(stage.rglob("*")):
                archive.add(path, arcname=str(path.relative_to(stage)), recursive=False)


def main() -> None:
    linux = Path(__file__).resolve().parents[1]
    with (linux / "Cargo.toml").open("rb") as source:
        version = tomllib.load(source)["package"]["version"]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, default=linux / "target/release/maple-linux")
    parser.add_argument(
        "--output", type=Path,
        help="Archive path; by default uses the built executable's architecture",
    )
    args = parser.parse_args()
    binary = args.binary.resolve()
    architecture = binary_architecture(binary)
    output = (args.output or Path.cwd() / f"maple-{version}-{architecture}-linux.tar.gz").resolve()
    package(binary, output)
    print(output)


if __name__ == "__main__":
    main()
