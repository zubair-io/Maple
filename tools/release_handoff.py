"""Version-only release handoff policy. Reads Git objects; never executes PR code."""

import json
import re
import subprocess

CONTEXT = "release-handoff-complete"
PACKAGE = "src/maple/package.json"
APPLE = "src/apple/Maple.xcodeproj/project.pbxproj"
CONSTANTS = {
    "src/maple/src/version.ts": r"(export const MAPLE_VERSION = ')[^']+(';)",
    "src/maple/dist/index.js": r'(var MAPLE_VERSION = ")[^"]+(";)',
    "src/maple/dist/version.d.ts": r'(export declare const MAPLE_VERSION = ")[^"]+(";)',
}


def git(*args):
    return subprocess.check_output(["git", *args], text=True).strip()


def blob(ref, path):
    return subprocess.check_output(["git", "show", f"{ref}:{path}"], text=True)


def semver(value):
    if not re.fullmatch(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)", value):
        raise ValueError(f"Expected a stable X.Y.Z version, got {value!r}")
    return tuple(map(int, value.split(".")))


def version(ref):
    value = json.loads(blob(ref, PACKAGE))["version"]
    semver(value)
    return value


def next_version(current, requested=""):
    major, minor, patch = semver(current)
    result = (
        requested.removeprefix("v") if requested else f"{major}.{minor}.{patch + 1}"
    )
    if semver(result) <= semver(current):
        raise ValueError(
            "Next development version must be greater than current version"
        )
    return result


def branch(current):
    semver(current)
    return f"release/next-v{current}"


def version_files(ref):
    packages = git("ls-tree", "-r", "--name-only", ref, "src/maple/npm").splitlines()
    return [
        PACKAGE,
        *[p for p in packages if p.endswith("/package.json")],
        APPLE,
        *CONSTANTS,
    ]


def render(path, text, old, new):
    """Require synchronized input and change only explicitly owned version fields."""
    if path.endswith("package.json"):
        package = json.loads(text)
        if package["version"] != old:
            raise ValueError(f"Version mismatch in {path}")
        package["version"] = new
        for name, value in package.get("optionalDependencies", {}).items():
            if name.startswith("@justmaple/maple-"):
                if value != old:
                    raise ValueError(f"Version mismatch for {name}")
                package["optionalDependencies"][name] = new
        return json.dumps(package, indent=2, ensure_ascii=False) + "\n"
    pattern = r"(MARKETING_VERSION = )([^;]+)(;)" if path == APPLE else None
    if pattern:
        matches = re.findall(pattern, text)
        if not matches or any(value != old for _, value, _ in matches):
            raise ValueError(f"Version mismatch in {path}")
        return re.sub(pattern, lambda m: m[1] + new + m[3], text)
    pattern = CONSTANTS[path]
    matches = list(re.finditer(pattern, text))
    if len(matches) != 1 or matches[0][0] != matches[0][1] + old + matches[0][2]:
        raise ValueError(f"Missing or inconsistent MAPLE_VERSION in {path}")
    return re.sub(pattern, lambda m: m[1] + new + m[2], text)


def expected_files(base, new):
    old = version(base)
    return {
        path: render(path, blob(base, path), old, new) for path in version_files(base)
    }


def validate_versions(ref):
    for path, expected in expected_files(ref, version(ref)).items():
        if blob(ref, path) != expected:
            raise ValueError(f"Version file is not canonical: {path}")


def validate_bump(base, head):
    new = next_version(version(base), version(head))
    expected = expected_files(base, new)
    changes = git("diff", "--name-only", base, head).splitlines()
    if set(changes) != set(expected):
        raise ValueError("Handoff must change every version file and no other files")
    for path, content in expected.items():
        if blob(head, path) != content:
            raise ValueError(f"Non-version change in {path}")
        # Content equality alone must not allow executable/symlink mode changes.
        before = git("ls-tree", base, "--", path).split()[0]
        after = git("ls-tree", head, "--", path).split()[0]
        if before != after:
            raise ValueError(f"File mode changed: {path}")


def allowed_pr(pr, main, handoff, tagged):
    # Statuses belong to a commit, not a PR. An identical fork head has exactly
    # the same validated tree and must not veto the legitimate bump's status.
    return bool(
        tagged
        and pr["head"]["sha"] == handoff
        and git("rev-parse", f"{handoff}^") == main
    )
