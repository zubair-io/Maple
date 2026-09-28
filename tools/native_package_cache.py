"""Fingerprint and validate native release artifacts; cache misses are harmless.

Manifest v1 is a flat object: version, target, platform, fingerprint, and files
(a mapping from the two fixed artifact basenames to their SHA256 digests).
Run from anywhere inside the repository. No paths are taken from the manifest.
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from pathlib import Path

PAIRS = {
    "x86_64-unknown-linux-gnu": ("linux-x64-gnu", "libraw_ffi.so"),
    "x86_64-unknown-linux-musl": ("linux-x64-musl", "libraw_ffi.so"),
    "aarch64-unknown-linux-gnu": ("linux-arm64-gnu", "libraw_ffi.so"),
    "aarch64-unknown-linux-musl": ("linux-arm64-musl", "libraw_ffi.so"),
    "aarch64-apple-darwin": ("darwin-arm64", "libraw_ffi.dylib"),
    "x86_64-apple-darwin": ("darwin-x64", "libraw_ffi.dylib"),
    "x86_64-pc-windows-msvc": ("win32-x64-msvc", "raw_ffi.dll"),
}
RUNNER_FIELDS = ("ImageOS", "ImageVersion", "RUNNER_OS", "RUNNER_ARCH")
COMPILER_FIELDS = {
    "RUSTFLAGS",
    "CARGO_ENCODED_RUSTFLAGS",
    "RUSTDOCFLAGS",
    "CC",
    "CXX",
    "CFLAGS",
    "CXXFLAGS",
    "CPPFLAGS",
    "LDFLAGS",
    "AR",
    "ARFLAGS",
    "RUSTC",
    "RUSTC_WRAPPER",
    "RUSTC_WORKSPACE_WRAPPER",
    "RUSTUP_TOOLCHAIN",
    "SDKROOT",
    "MACOSX_DEPLOYMENT_TARGET",
    "CARGO_BUILD_RUSTFLAGS",
    "CARGO_BUILD_RUSTC",
    "CARGO_BUILD_RUSTC_WRAPPER",
    "CARGO_BUILD_TARGET",
}


def in_ci():
    return any(
        os.environ.get(key, "").lower() not in ("", "false", "0")
        for key in ("CI", "GITHUB_ACTIONS")
    )


def command(root, *args):
    return subprocess.check_output(args, cwd=root, stderr=subprocess.PIPE)


def included(path):
    return not path.startswith(b"src/maple/") or path == (
        b"src/maple/scripts/audit-linkage.sh"
    )


def fingerprint(root, target, platform):
    if in_ci() and not os.environ.get("ImageVersion", "").strip():
        raise ValueError("ImageVersion must be nonempty in CI")
    dirty = command(root, "git", "diff", "--name-only", "--no-renames", "-z")
    dirty += command(
        root, "git", "diff", "--cached", "--name-only", "--no-renames", "-z", "HEAD"
    )
    if any(included(path) for path in dirty.split(b"\0") if path):
        raise ValueError("tracked native-package inputs are dirty")
    tree = command(root, "git", "ls-tree", "-r", "-z", "--full-tree", "HEAD")
    records = [
        record
        for record in tree.split(b"\0")
        if record and included(record.split(b"\t", 1)[1])
    ]
    # Native workflows invoke cargo --manifest-path from the repository root.
    versions = {"rustc": command(root, "rustc", "-Vv").decode("utf-8")}
    if "linux" in target:
        versions["zig"] = command(root, "zig", "version").decode("utf-8")
        versions["zigbuild"] = command(root, "cargo", "zigbuild", "--version").decode(
            "utf-8"
        )
    metadata = {
        "version": 1,
        "target": target,
        "platform": platform,
        "tools": versions,
        "runner": {name: os.environ.get(name) for name in RUNNER_FIELDS},
        "compiler_env": {
            name: value
            for name, value in sorted(os.environ.items())
            if name in COMPILER_FIELDS
            or name.startswith(
                (
                    "CARGO_TARGET_",
                    "CC_",
                    "CXX_",
                    "CFLAGS_",
                    "CXXFLAGS_",
                    "AR_",
                    "TARGET_",
                    "HOST_",
                    "ZIG_",
                )
            )
        },
    }
    digest = hashlib.sha256(json.dumps(metadata, sort_keys=True).encode() + b"\0")
    for record in records:
        digest.update(record + b"\0")
    return digest.hexdigest()


def safe_path(path):
    """Reject symlinks in every existing path component, including the leaf."""
    path = Path(os.path.abspath(path))
    # macOS exposes /tmp as a system alias; do not waive arbitrary symlinks.
    if sys.platform == "darwin" and path.is_relative_to("/tmp"):
        if Path("/tmp").resolve() == Path("/private/tmp"):
            path = Path("/private/tmp") / path.relative_to("/tmp")
    for part in (path, *path.parents):
        if part.is_symlink():
            raise ValueError(f"symlink is not allowed: {part}")
    return path


def regular(path):
    safe_path(path)
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_size == 0:
        raise ValueError(f"expected nonempty regular file: {path}")


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate manifest key")
        result[key] = value
    return result


def install(prepared, destination, names):
    """Replace a small file set with rollback if a copy or rename fails."""
    safe_path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    for name in names:
        path = destination / name
        safe_path(path)
        if path.exists() and not path.is_file():
            raise ValueError(f"destination is not a file: {path}")
    with tempfile.TemporaryDirectory(prefix=".native-install-", dir=destination) as tmp:
        scratch = Path(tmp)
        for name in names:
            shutil.copyfile(prepared / name, scratch / name)
        saved, installed = [], []
        try:
            for name in names:
                output = destination / name
                if output.exists():
                    os.replace(output, scratch / (name + ".old"))
                    saved.append(name)
                os.replace(scratch / name, output)
                installed.append(name)
        except OSError:
            for name in reversed(installed):
                (destination / name).unlink()
            for name in reversed(saved):
                os.replace(scratch / (name + ".old"), destination / name)
            raise


def manifest_for(args, files):
    return {
        "version": 1,
        "target": args.target,
        "platform": args.platform,
        "fingerprint": args.fingerprint,
        "files": files,
    }


def restore(args, cache, release, names):
    try:
        safe_path(cache)
        if {entry.name for entry in cache.iterdir()} != {*names, "manifest.json"}:
            raise ValueError("cache must contain exactly the manifest and two binaries")
        regular(cache / "manifest.json")
        manifest = json.loads(
            (cache / "manifest.json").read_text(), object_pairs_hook=unique_object
        )
        # Validate fixed filenames before consulting any manifest data.
        with tempfile.TemporaryDirectory(prefix="native-restore-") as tmp:
            prepared = Path(tmp).resolve()
            files = {}
            for name in names:
                regular(cache / name)
                shutil.copyfile(cache / name, prepared / name)
                regular(prepared / name)
                files[name] = sha256(prepared / name)
            if (
                manifest != manifest_for(args, files)
                or type(manifest["version"]) is not int
            ):
                raise ValueError("cache manifest or checksum mismatch")
            install(prepared, release, names)
        return True
    except (OSError, ValueError, TypeError, RecursionError) as exc:
        print(f"Native package cache miss: {exc}", file=sys.stderr)
        return False


def stage(args, cache, release, names):
    if in_ci() and (
        os.environ.get("GITHUB_REF") != "refs/heads/main"
        or os.environ.get("GITHUB_EVENT_NAME") != "workflow_dispatch"
    ):
        raise ValueError("CI cache staging requires workflow_dispatch on main")
    safe_path(cache)
    if cache.exists() and {p.name for p in cache.iterdir()} - {*names, "manifest.json"}:
        raise ValueError("unexpected files in cache directory")
    with tempfile.TemporaryDirectory(prefix="native-stage-") as tmp:
        prepared = Path(tmp).resolve()
        files = {}
        for name in names:
            regular(release / name)
            shutil.copyfile(release / name, prepared / name)
            regular(prepared / name)
            files[name] = sha256(prepared / name)
        (prepared / "manifest.json").write_text(
            json.dumps(manifest_for(args, files), sort_keys=True) + "\n"
        )
        install(prepared, cache, (*names, "manifest.json"))


def output(path, values):
    text = "".join(f"{key}={value}\n" for key, value in values.items())
    if path:
        with Path(path).open("a", encoding="utf-8") as stream:
            stream.write(text)
    else:
        print(text, end="")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="action", required=True)
    for action in ("fingerprint", "restore", "stage"):
        sub = subparsers.add_parser(action)
        sub.add_argument("--target", required=True, choices=PAIRS)
        sub.add_argument("--platform", required=True)
        sub.add_argument("--github-output", required=action != "stage")
        if action != "fingerprint":
            sub.add_argument("--fingerprint", required=True)
            sub.add_argument("--cache-dir", required=True)
    args = parser.parse_args(argv)
    platform, library = PAIRS[args.target]
    if args.platform != platform:
        parser.error("unsupported target/platform pair")
    if args.action != "fingerprint" and not re.fullmatch(
        r"[0-9a-f]{64}", args.fingerprint
    ):
        parser.error("fingerprint must be a lowercase SHA256 digest")
    try:
        root = Path(
            os.fsdecode(
                command(Path.cwd(), "git", "rev-parse", "--show-toplevel")
            ).strip()
        ).resolve()
        if args.action == "fingerprint":
            value = fingerprint(root, args.target, args.platform)
            output(
                args.github_output,
                {"key": f"native-package-v1-{value}", "fingerprint": value},
            )
        else:
            cache = Path(args.cache_dir).absolute()
            release = root / "src/raw-pipeline/target" / args.target / "release"
            names = (library, f"raw-napi.{platform}.node")
            if args.action == "restore":
                reused = restore(args, cache, release, names)
                output(args.github_output, {"reused": str(reused).lower()})
            else:
                if (
                    in_ci()
                    and fingerprint(root, args.target, args.platform)
                    != args.fingerprint
                ):
                    raise ValueError("native-package inputs changed before staging")
                stage(args, cache, release, names)
        return 0
    except (OSError, ValueError, subprocess.CalledProcessError) as exc:
        print(f"Native package cache error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
