#!/usr/bin/env python3
"""Prepare only an owned, signed, sandboxed #4140 GUI qualification copy."""

import argparse
import hashlib
import json
import plistlib
import shutil
import struct
import subprocess
import uuid
from pathlib import Path


def sections(executable):
    data = executable.read_bytes()
    assert struct.unpack_from("<I", data)[0] == 0xFEEDFACF, (
        "Expected built arm64 Mach-O"
    )
    count = struct.unpack_from("<I", data, 16)[0]
    offset = 32
    hashes = {}
    for _ in range(count):
        command, size = struct.unpack_from("<II", data, offset)
        if command == 0x19:
            number = struct.unpack_from("<I", data, offset + 64)[0]
            for index in range(number):
                section = offset + 72 + index * 80
                name = data[section : section + 16].split(b"\0")[0].decode()
                segment = data[section + 16 : section + 32].split(b"\0")[0].decode()
                length = struct.unpack_from("<Q", data, section + 40)[0]
                start = struct.unpack_from("<I", data, section + 48)[0]
                if start and length:
                    hashes[f"{segment}/{name}"] = hashlib.sha256(
                        data[start : start + length]
                    ).hexdigest()
        offset += size
    return hashes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--identity", required=True)
    parser.add_argument("--fixture", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        parser.error(
            "Output must be a new owned directory; previous evidence is never replaced"
        )
    args.output.mkdir(parents=True)
    app = args.output / "Maple.app"
    shutil.copytree(args.app, app, symlinks=True)
    info_path = app / "Contents/Info.plist"
    with info_path.open("rb") as stream:
        info = plistlib.load(stream)
    identifier = "app.maple.q." + uuid.uuid4().hex[:16]
    info["CFBundleIdentifier"] = identifier
    info["CFBundleName"] = "Maple MCP Qualification"
    info["CFBundleDisplayName"] = "Maple MCP Qualification"
    for key in (
        "CFBundleURLTypes",
        "CFBundleDocumentTypes",
        "UTExportedTypeDeclarations",
        "UTImportedTypeDeclarations",
    ):
        info.pop(key, None)
    info_path.write_bytes(plistlib.dumps(info))
    # The photo-editor acceptance does not launch extensions or register any
    # production File Provider / widget bundle identifiers from the copied app.
    plugins = app / "Contents/PlugIns"
    if plugins.exists():
        shutil.rmtree(plugins)
    profile = app / "Contents/embedded.provisionprofile"
    if profile.exists():
        profile.unlink()
    entitlements = {
        "com.apple.security.app-sandbox": True,
        "com.apple.security.files.bookmarks.app-scope": True,
        "com.apple.security.files.user-selected.read-write": True,
        "com.apple.security.network.client": True,
    }
    entitlement_path = args.output / "sandbox.entitlements"
    entitlement_path.write_bytes(plistlib.dumps(entitlements))
    executable = app / "Contents/MacOS" / info["CFBundleExecutable"]
    before = sections(executable)
    compiled_images = {}
    for image in app.rglob("*"):
        if image.is_file():
            with image.open("rb") as stream:
                magic = stream.read(4)
            if magic == b"\xcf\xfa\xed\xfe":
                compiled_images[str(image.relative_to(app))] = sections(image)
    subprocess.run(
        [
            "codesign",
            "--force",
            "--sign",
            args.identity,
            "--entitlements",
            str(entitlement_path),
            str(app),
        ],
        check=True,
    )
    subprocess.run(["codesign", "--verify", "--deep", "--strict", str(app)], check=True)
    assert sections(executable) == before, (
        "Signing must preserve every compiled section"
    )
    directory = Path.home() / "Library/Containers" / identifier / "Data/tmp/mcp-ui"
    assert len(str(directory / "agent.sock").encode()) < 104
    directory.mkdir(parents=True, exist_ok=False)
    fixture = directory / args.fixture.name
    shutil.copy2(args.fixture, fixture)
    sidecar = fixture.with_suffix(".xmp")
    sidecar.write_text(
        '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Exposure2012="0"/></rdf:RDF></x:xmpmeta>\n'
    )
    provenance = {
        "built_app": str(args.app.resolve()),
        "owned_app": str(app.resolve()),
        "bundle_id": identifier,
        "entitlements": entitlements,
        "original_executable_sha256": hashlib.sha256(
            (args.app / "Contents/MacOS" / info["CFBundleExecutable"]).read_bytes()
        ).hexdigest(),
        "signed_copy_executable_sha256": hashlib.sha256(
            executable.read_bytes()
        ).hexdigest(),
        "identical_compiled_sections": before,
        "identical_compiled_images": compiled_images,
        "fixture_directory": str(directory),
        "fixture": str(fixture),
        "sidecar": str(sidecar),
        "source_fixture": str(args.fixture.resolve()),
        "source_fixture_sha256": hashlib.sha256(args.fixture.read_bytes()).hexdigest(),
        "initial_xmp_sha256": hashlib.sha256(sidecar.read_bytes()).hexdigest(),
        "excluded_copy_registrations": [
            "PlugIns",
            "provisioning profile",
            "URL schemes",
            "document types",
        ],
    }
    (args.output / "provenance.json").write_text(
        json.dumps(provenance, indent=2) + "\n"
    )
    print(
        json.dumps(
            {
                "bundle_id": identifier,
                "owned_app": str(app.resolve()),
                "fixture_directory": provenance["fixture_directory"],
            }
        )
    )


if __name__ == "__main__":
    main()
