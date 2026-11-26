"""Strip first-party build output from the build folders CI keeps in its cache (#6122).

Run before a cache is saved and again after one is restored, so a build can only
reuse third-party objects. An entry of a kind the rules do not know is removed,
build plans included; a Swift target folder is removed when its name is
first-party, and a crate folder unless its name is third-party. Only SwiftPM's
native build layout is understood: the Swift Build layout (`.build/out`) is
removed whole.
"""

import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

SWIFTPM_ROOT_KEPT = frozenset(
    (
        "checkouts",
        "repositories",
        "artifacts",
        "plugins",
        "build.db",
        "workspace-state.json",
        "CACHEDIR.TAG",
        ".lock",
    )
)
SWIFTPM_MODULE_FOLDERS = frozenset(("Modules", "Modules-tool"))
SWIFTPM_HOST_TOOL_TYPES = frozenset(("plugin", "macro"))
CARGO_ROOT_KEPT = frozenset(("CACHEDIR.TAG", ".rustc_info.json"))
CARGO_LIBRARY_KINDS = frozenset(
    ("lib", "rlib", "dylib", "cdylib", "staticlib", "proc-macro")
)
TARGET_TRIPLE = re.compile(r"[a-z0-9_]+-[a-z0-9_]+-[a-z0-9_.]+")
CARGO_PROFILE_KEPT = frozenset(("build", ".fingerprint", "deps"))


def run_json(command, cwd=None):
    output = subprocess.run(command, cwd=cwd, check=True, stdout=subprocess.PIPE)
    return json.loads(output.stdout)


def describe_package(package):
    command = ["swift", "package", "--package-path", str(package), "describe"]
    return run_json([*command, "--type", "json"])


def swiftpm_first_party_targets(package, describe, seen=frozenset()):
    """Targets of `package` and of every package it reaches by a local path."""
    # SwiftPM allows local packages to depend on each other in a cycle.
    if package in seen:
        return frozenset()
    description = describe(package)
    local = [
        Path(dependency["path"])
        for dependency in description.get("dependencies", [])
        if dependency.get("type") == "fileSystem"
    ]
    host_tools = [
        target["name"]
        for target in description["targets"]
        if target.get("type") in SWIFTPM_HOST_TOOL_TYPES
    ]
    if host_tools:
        # The rules have never met a real plugin or macro build.
        raise SystemExit(
            f"First-party plugin or macro targets {host_tools} in {package}: "
            "teach tools/third_party_build_cache.py where their output lives."
        )
    own = {
        name
        for target in description["targets"]
        for name in (target["name"], target["c99name"])
    }
    return frozenset(own | {f"{description['name']}PackageTests"}).union(
        *(
            swiftpm_first_party_targets(path, describe, seen | {package})
            for path in local
        )
    )


def swiftpm_entry_is_third_party(entry, targets):
    name = entry.name
    # Host tools (macros, plugins) build into `<Target>-tool.build`.
    stem = name.rsplit(".", 1)[0]
    stems = (stem, stem.removesuffix("-tool"))
    if name.endswith(".build"):
        return not any(candidate in targets for candidate in stems)
    if name.endswith(".bundle"):
        return not any(
            candidate.endswith(f"_{target}")
            for candidate in stems
            for target in targets
        )
    return name in SWIFTPM_MODULE_FOLDERS or name.startswith("swift-version")


def swiftpm_first_party_output(build, targets):
    if not build.is_dir():
        return []
    top = [entry for entry in build.iterdir() if not entry.is_symlink()]
    triples = [
        entry for entry in top if entry.is_dir() and TARGET_TRIPLE.fullmatch(entry.name)
    ]
    unknown = [
        entry
        for entry in top
        if entry not in triples
        and entry.name not in SWIFTPM_ROOT_KEPT
        and not entry.name.startswith(".buildSystem_")
    ]
    configurations = [
        entry
        for triple in triples
        for entry in triple.iterdir()
        if entry.is_dir() and not entry.is_symlink()
    ]
    loose = [
        entry
        for triple in triples
        for entry in triple.iterdir()
        if entry not in configurations
    ]
    products = [
        entry
        for configuration in configurations
        for entry in configuration.iterdir()
        if not swiftpm_entry_is_third_party(entry, targets)
    ]
    modules = [
        entry
        for configuration in configurations
        for folder in SWIFTPM_MODULE_FOLDERS
        for entry in (configuration / folder).glob("*")
        if entry.name.split(".")[0] in targets
    ]
    generated = [
        entry
        for entry in (build / "plugins" / "outputs").glob("*/*")
        if entry.name in targets
    ]
    return sorted(unknown + loose + products + modules + generated)


def cargo_third_party_names(metadata):
    """Package names and library names that only registry or git crates use."""

    def normalised(names):
        return {name.replace("-", "_") for name in names}

    local = [package for package in metadata["packages"] if package["source"] is None]
    remote = [
        package for package in metadata["packages"] if package["source"] is not None
    ]
    first_party = normalised(
        [package["name"] for package in local]
        + [target["name"] for package in local for target in package["targets"]]
    )
    libraries = normalised(
        target["name"]
        for package in remote
        for target in package["targets"]
        if CARGO_LIBRARY_KINDS & set(target["kind"])
    )
    packages = normalised(package["name"] for package in remote)
    return frozenset(packages - first_party), frozenset(libraries - first_party)


def cargo_metadata(workspace):
    command = ["cargo", "metadata", "--locked", "--all-features"]
    return run_json([*command, "--format-version", "1"], cwd=workspace)


def cargo_first_party_output(target, packages, libraries):
    profiles = [
        entry.parent
        for pattern in ("*/.fingerprint", "*/*/.fingerprint")
        for entry in target.glob(pattern)
    ]

    def third_party(entry):
        stem = entry.name.split(".")[0].rsplit("-", 1)[0].replace("-", "_")
        if entry.parent.name == "deps":
            return stem in libraries or stem.removeprefix("lib") in libraries
        return stem in packages

    folders = {target} | {profile.parent for profile in profiles}
    unknown = [
        entry
        for folder in folders
        for entry in folder.glob("*")
        if entry not in (*profiles, *folders) and entry.name not in CARGO_ROOT_KEPT
    ]
    loose = [
        entry
        for profile in profiles
        for entry in profile.iterdir()
        if entry.name not in CARGO_PROFILE_KEPT
    ]
    built = [
        entry
        for profile in profiles
        for directory in CARGO_PROFILE_KEPT
        for entry in (profile / directory).glob("*")
        if not third_party(entry)
    ]
    return sorted(unknown + loose + built)


def remove(path):
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)
    else:
        path.unlink(missing_ok=True)


def main(arguments):
    restored = "--restored" in arguments
    positional = [argument for argument in arguments if argument != "--restored"]
    if positional[:1] == ["swiftpm"] and len(positional) == 2:
        package = Path(positional[1])
        folder = package / ".build"
        found = (
            swiftpm_first_party_output(
                folder, swiftpm_first_party_targets(package, describe_package)
            )
            if folder.is_dir()
            else []
        )
    elif positional[:1] == ["cargo"] and len(positional) == 3:
        folder = Path(positional[2])
        found = (
            cargo_first_party_output(
                folder, *cargo_third_party_names(cargo_metadata(positional[1]))
            )
            if folder.is_dir()
            else []
        )
    else:
        raise SystemExit(
            "usage: third_party_build_cache.py swiftpm <package> [--restored]\n"
            "       third_party_build_cache.py cargo <workspace> <target> [--restored]"
        )
    for path in found:
        remove(path)
    summary = f"Removed {len(found)} entries that are not third-party from {folder}"
    # A restored cache was stripped before it was saved: rules or lockfile moved.
    print(f"::warning::{summary}" if restored and found else summary)


if __name__ == "__main__":
    main(sys.argv[1:])
