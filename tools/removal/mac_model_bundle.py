"""Build a verified offline Mac testing folder, with provenance/notices (#1472).

No downloads, signing, app installation, or release qualification. Model pins
come from codegen; runtime pins come from compiling the actual Swift manifest.
Only a complete verified staging directory is published. Requires macOS/Xcode
and the existing export outputs plus the official runtime tarball.
"""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import tarfile
import tempfile
from pathlib import Path, PurePosixPath

REPO = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
CHUNK = 1024 * 1024


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def verify(path, expected, size=None):
    if not path.is_file() or (size is not None and path.stat().st_size != size):
        raise ValueError(f"Missing file or wrong size: {path}")
    if digest(path) != expected:
        raise ValueError(f"SHA-256 mismatch: {path}")


def copy_verified(source, target, expected, size=None):
    # Hash the copied bytes too: source can change between preflight and copy.
    verify(source, expected, size)
    target.parent.mkdir(parents=True, exist_ok=True)
    with source.open("rb") as incoming, target.open("xb") as outgoing:
        shutil.copyfileobj(incoming, outgoing, CHUNK)
    verify(target, expected, size)


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def runtime_manifest():
    manifest = (
        REPO
        / "src/apple/Packages/MapleCore/Sources/MapleCore/Panorama"
        / "PanoProvisionManifest.swift"
    )
    with tempfile.TemporaryDirectory(prefix="maple-runtime-pins-") as directory:
        executable = Path(directory) / "runtime-pins"
        subprocess.run(
            [
                "xcrun",
                "swiftc",
                str(manifest),
                str(HERE / "mac_runtime_manifest.swift"),
                "-o",
                str(executable),
            ],
            check=True,
        )
        return json.loads(subprocess.check_output([str(executable)], text=True))


def relative_file(name):
    path = PurePosixPath(name)
    if path.is_absolute() or not path.parts or ".." in path.parts:
        raise ValueError(f"Unsafe relative file: {name}")
    return Path(name)


def archive_file(members, name, root):
    # Never extract an archive into the filesystem. Resolve only the required
    # in-archive link, confined to this distribution root, then stream its data.
    visited = set()
    while name not in visited:
        path = PurePosixPath(name)
        if path.is_absolute() or ".." in path.parts or path.parts[0] != root:
            raise ValueError(f"Unsafe runtime archive path: {name}")
        visited.add(name)
        member = members.get(name)
        if member is None:
            raise ValueError(f"Missing runtime archive file: {name}")
        if member.isfile():
            return member
        if member.issym():
            name = str(path.parent / member.linkname)
        elif member.islnk():
            name = member.linkname
        else:
            raise ValueError(f"Not a regular runtime archive file: {name}")
    raise ValueError(f"Runtime archive link cycle: {name}")


def install_runtime(archive_path, runtime, staging):
    verify(archive_path, runtime["archive_sha256"], runtime["archive_size"])
    internal = runtime["internal_path"]
    root = PurePosixPath(internal).parts[0]
    required = {internal: "runtime.dylib"}
    required.update(
        {
            f"{root}/{name}": f"provenance/runtime/{name}"
            for name in (
                "LICENSE",
                "ThirdPartyNotices.txt",
                "VERSION_NUMBER",
                "GIT_COMMIT_ID",
                "Privacy.md",
            )
        }
    )
    with tarfile.open(archive_path, "r:gz") as archive:
        entries = archive.getmembers()
        members = {str(PurePosixPath(entry.name)): entry for entry in entries}
        if len(members) != len(entries):
            raise ValueError("Duplicate runtime archive entries")
        for name, destination in required.items():
            member = archive_file(members, name, root)
            if member.size > (256 * CHUNK if name == internal else CHUNK):
                raise ValueError(f"Oversized runtime archive member: {name}")
            target = staging / destination
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.extractfile(member) as incoming, target.open("xb") as outgoing:
                shutil.copyfileobj(incoming, outgoing, CHUNK)
    verify(staging / "runtime.dylib", runtime["installed_sha256"])
    # Authenticate the archive again after reading it, before publication.
    verify(archive_path, runtime["archive_sha256"], runtime["archive_size"])


def install_models(exports, pins, review, staging):
    if {pin["id"] for pin in pins} != {"lama", "encoder", "decoder", "detector"} or len(
        pins
    ) != 4:
        raise ValueError("Expected the complete four-model testing set")
    for pin in pins:
        if pin["release_qualified"] is not False:
            raise ValueError("This builder is limited to unqualified testing models")
        source = exports / relative_file(pin["probe_path"])
        if Path(pin["file"]).name != pin["file"] or source.name != pin["file"]:
            raise ValueError("Invalid generated model filename")
        record = review["exports"][pin["id"]]
        metadata_path = source.with_suffix(".json")
        verify(metadata_path, record["metadata_sha256"])
        metadata = json.loads(metadata_path.read_text())
        checkpoint = metadata.get(
            "checkpoint_sha256",
            metadata.get("source_digests", {}).get("weights/mobile_sam.pt"),
        )
        if (
            metadata["artifact_sha256"] != pin["sha256"]
            or metadata["source_revision"] != pin["source_revision"]
            or checkpoint != pin["checkpoint_sha256"]
            or metadata["release_qualified"] is not False
        ):
            raise ValueError(
                f"Export provenance does not match generated pin: {pin['id']}"
            )
        copy_verified(source, staging / pin["file"], pin["sha256"], pin["size"])
        copy_verified(
            metadata_path,
            staging / "provenance" / f"{pin['id']}.json",
            record["metadata_sha256"],
        )
        license_path = source.parent / relative_file(record["license_file"])
        copy_verified(
            license_path,
            staging / "provenance" / f"{pin['id']}-LICENSE",
            record["license_sha256"],
        )


def build_bundle(exports, archive, output, pins, runtime, review, review_root):
    if os.path.lexists(output):
        raise ValueError(f"Output already exists; choose a new directory: {output}")
    if (
        review["release_qualified"] is not False
        or review["public_distribution_approved"] is not False
    ):
        raise ValueError("Local testing packaging cannot approve public distribution")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix=".maple-model-bundle-", dir=output.parent
    ) as directory:
        staging = Path(directory) / "bundle"
        staging.mkdir()
        install_models(exports, pins, review, staging)
        install_runtime(archive, runtime, staging)
        for notice in review["additional_notices"]:
            path = relative_file(notice["file"])
            copy_verified(
                review_root / path, staging / "provenance" / path, notice["sha256"]
            )
        write_json(staging / "provenance/review.json", review)
        write_json(staging / "provenance/model-pins.json", pins)
        write_json(staging / "provenance/runtime-pins.json", runtime)
        files = [
            {
                "file": str(path.relative_to(staging)),
                "size": path.stat().st_size,
                "sha256": digest(path),
            }
            for path in sorted(staging.rglob("*"))
            if path.is_file()
        ]
        write_json(
            staging / "bundle.json",
            {
                "schema": 1,
                "purpose": "offline-mac-testing",
                "architecture": runtime["architecture"],
                "release_qualified": False,
                "public_distribution_approved": False,
                "files": files,
                "import": "In the Mac editor, open Remove, choose Import model folder, and select this folder. Keep provenance alongside the bundle; the current app installer copies inference files only.",
            },
        )
        # A manifest is an inventory, not a signature or a notarization claim.
        if os.path.lexists(output):
            raise ValueError(f"Output appeared during packaging: {output}")
        staging.rename(output)
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--exports", required=True, type=Path, help="Probe/export root")
    parser.add_argument(
        "--ort-archive",
        required=True,
        type=Path,
        help="Official tarball for this Mac's architecture",
    )
    parser.add_argument(
        "--output",
        required=True,
        type=Path,
        help="New offline folder; existing paths are refused",
    )
    args = parser.parse_args()
    pins = json.loads((HERE / "removal-models.generated.json").read_text())
    review = json.loads((HERE / "model-distribution-review.json").read_text())
    output = build_bundle(
        args.exports,
        args.ort_archive,
        args.output,
        pins,
        runtime_manifest(),
        review,
        HERE,
    )
    print(output.resolve())


if __name__ == "__main__":
    main()
