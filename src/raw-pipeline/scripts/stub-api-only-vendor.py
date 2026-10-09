#!/usr/bin/env python3
"""Reduce vendored crates that only the API-only `maple-search` crate reaches
to manifest-only stubs (#4462).

`vendor/` exists for the Apple xcframework's offline build. That build never
compiles maple-search (raw-ffi's `search` feature is API-only), but its offline
resolution still reads the manifest of every package in Cargo.lock. So a
package reachable only through maple-search needs its Cargo.toml, a checksum
file carrying the lockfile's package checksum, and empty target files —
not its ~330 MB of sources (mostly Windows import libraries).

Run from src/raw-pipeline after `cargo vendor vendor` and
`scripts/re-apply-patches.sh`. Idempotent.
"""
import json
import pathlib
import shutil
import subprocess
import sys
import tomllib

API_ONLY_ROOT = "maple-search"
RAW_PIPELINE = pathlib.Path(__file__).resolve().parent.parent
VENDOR = RAW_PIPELINE / "vendor"
STUB_MARKER = "MAPLE-API-ONLY-STUB"


def resolve_graph():
    metadata = json.loads(
        subprocess.check_output(
            ["cargo", "metadata", "--format-version", "1", "--all-features", "--locked"],
            cwd=RAW_PIPELINE,
        )
    )
    packages = {p["id"]: p for p in metadata["packages"]}
    edges = {node["id"]: [dep["pkg"] for dep in node["deps"]] for node in metadata["resolve"]["nodes"]}
    return packages, edges, metadata["workspace_members"]


def reachable(roots, edges, skip):
    seen, stack = set(), list(roots)
    while stack:
        node = stack.pop()
        if node in seen or node in skip:
            continue
        seen.add(node)
        stack.extend(edges.get(node, []))
    return seen


def api_only_packages():
    packages, edges, members = resolve_graph()
    root = next(m for m in members if packages[m]["name"] == API_ONLY_ROOT)
    others = [m for m in members if m != root]
    shared = reachable(others, edges, skip={root})
    only = reachable([root], edges, skip=set()) - shared - set(members)
    return {(packages[p]["name"], packages[p]["version"]) for p in only if packages[p]["source"]}


def vendored_dirs():
    for directory in sorted(VENDOR.iterdir()):
        manifest = directory / "Cargo.toml"
        if directory.is_dir() and manifest.exists():
            package = tomllib.loads(manifest.read_text())["package"]
            yield directory, (package["name"], package["version"])


def target_paths(manifest):
    lib = manifest.get("lib", {}).get("path", "src/lib.rs")
    build = manifest["package"].get("build")
    return [lib] + ([build] if isinstance(build, str) else [])


def stub(directory):
    if (directory / STUB_MARKER).exists():
        return False
    manifest_text = (directory / "Cargo.toml").read_text()
    package_checksum = json.loads((directory / ".cargo-checksum.json").read_text())["package"]
    for child in directory.iterdir():
        if child.is_dir():
            shutil.rmtree(child)
        else:
            child.unlink()
    (directory / "Cargo.toml").write_text(manifest_text)
    for relative in target_paths(tomllib.loads(manifest_text)):
        path = directory / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("")
    (directory / STUB_MARKER).write_text(
        "Manifest-only stub: reachable only through the API-only maple-search crate,\n"
        "which the Apple offline build never compiles. See scripts/stub-api-only-vendor.py.\n"
    )
    (directory / ".cargo-checksum.json").write_text(
        json.dumps({"files": {}, "package": package_checksum})
    )
    return True


def main():
    targets = api_only_packages()
    stubbed = [d.name for d, ident in vendored_dirs() if ident in targets and stub(d)]
    print(f"{len(targets)} API-only packages; stubbed {len(stubbed)} vendor dirs")
    for name in stubbed:
        print(f"  {name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
