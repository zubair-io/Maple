"""Conservative heavy-CI selector; uncertainty always selects every consumer."""

import json
import os
import re
import subprocess
from functools import cache
from pathlib import Path

BUILD_CONSUMERS = ("android", "windows", "web", "api", "maple", "codegen", "swift")
CONSUMERS = (*BUILD_CONSUMERS, "release", "ci")
BUILDS = frozenset(BUILD_CONSUMERS)
ALL = frozenset(CONSUMERS)
CODEGEN_DOCS = frozenset(
    f"docs/{name}.{extension}"
    for name in ("capability-registry", "camera-support")
    for extension in ("md", "json")
)
ROOT = Path(__file__).resolve().parent.parent
# Swift (macOS-runner) jobs boot these API fixture servers and read the files
# below outside src/apple. An API change reaches Swift only through the
# fixtures' transitive imports, which swift_api_closure() walks.
SWIFT_API_ENTRY_POINTS = (
    "src/api/tests/fixtures/file-provider-restart.ts",
    "src/api/tests/fixtures/unified-folder-server.ts",
    "src/api/tests/browser/workflow-server.ts",
)
SWIFT_API_INPUTS = frozenset(("src/api/package.json", "src/api/bun.lock"))
IMPORT_SPECIFIER = re.compile(
    r"""(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"](\.{1,2}/[^'"]*)['"]"""
)
# Whole-line comments only: stripping /* */ spans could swallow real imports
# after a glob string such as "**/*.ts".
COMMENT_LINE = ("//", "*", "/*")
SOURCE_SUFFIXES = (".ts", ".tsx", ".js", ".mjs", ".json")


def resolve_import(root, importer, specifier):
    base = (root / importer).parent / specifier
    stem = base.with_suffix("") if base.suffix in (".js", ".mjs") else base
    for candidate in (
        base,
        *(Path(f"{stem}{suffix}") for suffix in SOURCE_SUFFIXES),
        *(stem / f"index{suffix}" for suffix in SOURCE_SUFFIXES),
    ):
        if candidate.is_file():
            return candidate.resolve().relative_to(root.resolve()).as_posix()
    return None


@cache
def swift_api_closure(root=ROOT):
    """Files the Swift-booted API fixtures import, and whether the walk was complete."""
    root = Path(root)
    pending = list(SWIFT_API_ENTRY_POINTS)
    seen = set()
    complete = True
    while pending:
        path = pending.pop()
        if path in seen:
            continue
        seen.add(path)
        file = root / path
        if not file.is_file():
            complete = False
            continue
        if file.suffix not in (".ts", ".tsx", ".js", ".mjs"):
            continue
        try:
            source = file.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            complete = False
            continue
        code = "\n".join(
            line
            for line in source.splitlines()
            if not line.lstrip().startswith(COMMENT_LINE)
        )
        for specifier in IMPORT_SPECIFIER.findall(code):
            try:
                resolved = resolve_import(root, path, specifier)
            except ValueError:
                resolved = None
            if resolved is None:
                complete = False
            else:
                pending.append(resolved)
    return frozenset(seen), complete


def is_maple_runtime(path):
    # src/api installs `maple` from file:../maple and the workflow fixture imports it.
    return (
        path.startswith("src/maple/")
        and not path.endswith(".md")
        and "/test/" not in path
    )


def affects_swift_api(path, root=ROOT):
    closure, complete = swift_api_closure(root)
    return not complete or path in closure


SWIFT_WEB_INPUTS = frozenset(
    (
        "src/web/package.json",
        "src/web/bun.lock",
        "src/web/playwright.recipe-interchange.config.ts",
        "src/web/projects/maple-common/src/lib/export/export-recipe-store.ts",
        "src/web/projects/maple-common/src/lib/generated/export-recipe.generated.ts",
    )
)
SWIFT_DOCS = frozenset(("docs/design/maple-ui/apple-icon-inventory.json",))
METADATA = frozenset(
    name + extension
    for name in ("README", "AGENTS", "CLAUDE", "LICENSE")
    for extension in ("", ".md", ".txt")
)


def selection(consumers, reason):
    return {name: name in consumers for name in CONSUMERS}, reason


def dependencies(path):
    parts = path.split("/")
    if not path or any(part in ("", ".", "..") for part in parts):
        return ALL
    if path.startswith(("tools/release_", "tools/test_release_")) or path in (
        "tools/sync-release-version.sh",
        ".github/workflows/version-sync.yml",
        ".github/workflows/release-handoff.yml",
    ):
        return {"release"}
    if path in ("tools/generate_nlm_exp_table.py", "tools/test_nlm_exp_table.py"):
        return {"codegen"}
    if path.startswith((".github/workflows/", ".github/actions/")) or (
        not path.startswith("src/android/")
        and any(part in ("scripts", "ci_scripts") for part in parts[:-1])
    ):
        return ALL
    if path.startswith(("src/raw-pipeline/", "test-fixtures/", "tools/qualification/")):
        return BUILDS
    if path.startswith("src/apple/MapleUITests/Goldens/.calibration/"):
        return BUILDS
    # Android stages the shared layout raster and exports MapleUI's bundled
    # fonts/glyphs. Ordinary Swift changes are still codegen-only.
    if path.startswith(
        (
            "src/apple/MapleUITests/Fixtures/",
            "src/apple/Packages/MapleUI/Sources/MapleUI/Resources/",
        )
    ):
        return {"android", "codegen", "swift"}
    if path == (
        "src/apple/Packages/MapleCore/Sources/MapleCore/Resources/builtin-presets.json"
    ):
        return {"api", "maple", "web", "codegen", "swift"}
    if path.startswith(
        (
            "src/apple/Maple/Assets.xcassets/AppIcon.appiconset/",
            "src/apple/Maple/Assets.xcassets/LaunchLogo.imageset/",
        )
    ):
        return {"android", "web", "codegen", "swift"}
    if path.startswith("docs/design/maple-ui/components/"):
        return {"web"}
    if path in SWIFT_DOCS:
        return {"swift"}
    generated = "generated" in path.lower().split("/") or path.endswith(
        (".generated.ts", ".g.cs")
    )
    codegen = (
        {"codegen"}
        if generated
        or path
        in (
            "src/api/src/routes/xmp.sidecar-contract.test.ts",
            "src/android/native/src/fields.rs",
            "src/android/app/src/main/res/values/maple-tokens.xml",
        )
        else set()
    )
    swift = (
        {"swift"}
        if path in SWIFT_API_INPUTS
        or affects_swift_api(path)
        or is_maple_runtime(path)
        or path in SWIFT_WEB_INPUTS
        or path.startswith("src/web/e2e/recipe-interchange/")
        else set()
    )
    if path.startswith("src/android/"):
        return {"android"} | codegen
    if path == "src/maple/package.json":
        return {"android", "api", "maple", "web"} | swift
    # Android's shared folder writer pins these API-owned cache tier parameters.
    if path in ("src/api/src/thumbs/render.ts", "src/api/src/indexer/previewer.ts"):
        return {"android", "api", "maple", "web"} | codegen | swift
    if path.startswith(("src/api/", "src/maple/")):
        return {"api", "maple", "web"} | codegen | swift
    if path.startswith("src/web/"):
        android = (
            {"android"}
            if path.startswith(
                (
                    "src/web/projects/maple-common/src/lib/icons/",
                    "src/web/projects/maple-common/src/lib/maple-cache/",
                )
            )
            else set()
        )
        return {"api", "web"} | codegen | android | swift
    if path.startswith("src/windows/"):
        return (
            {"windows"}
            | codegen
            | (
                {"codegen"}
                if path == "src/windows/Maple.WinUI/Themes/Tokens.xaml"
                else set()
            )
        )
    if path.startswith("src/apple/"):
        return {"codegen", "swift"}
    if path in CODEGEN_DOCS:
        return {"codegen"}
    if path.startswith("docs/") or path in METADATA:
        return frozenset()
    return ALL


def classify_paths(paths):
    if not paths:
        return selection(ALL, "Empty diff; conservatively running all consumers.")
    consumers = frozenset().union(*(dependencies(path) for path in paths))
    return selection(
        consumers,
        f"Classified {len(paths)} changed paths using conservative dependency rules "
        "(unknown paths select all consumers).",
    )


def valid_sha(value):
    if (
        not isinstance(value, str)
        or not re.fullmatch(r"(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})", value)
        or set(value) == {"0"}
    ):
        raise ValueError("Missing, zero, or invalid commit SHA")
    return value


def git(repo, *args):
    return subprocess.run(
        ["git", *args], cwd=repo, check=True, capture_output=True, timeout=60
    ).stdout


def select(event_name, event, repo="."):
    if event_name not in ("pull_request", "push"):
        return selection(
            ALL, "Manual, reusable, or unknown event; running all consumers."
        )
    try:
        if event_name == "pull_request":
            pr = event["pull_request"]
            head_ref = pr["head"]["ref"]
            if not isinstance(head_ref, str) or not head_ref:
                raise ValueError("Missing PR head ref")
            if head_ref.startswith("release/next-v"):
                return selection(ALL, "Release PR override; running all consumers.")
            base, head = valid_sha(pr["base"]["sha"]), valid_sha(pr["head"]["sha"])
        else:
            base, head = valid_sha(event["before"]), valid_sha(event["after"])
        for sha in (base, head):
            if git(repo, "cat-file", "-t", sha).strip() != b"commit":
                raise ValueError("Event SHA is not a commit")
        start = (
            valid_sha(git(repo, "merge-base", "--all", base, head).decode().strip())
            if event_name == "pull_request"
            else base
        )
        raw = git(repo, "diff", "--name-only", "-z", "--no-renames", start, head, "--")
        if raw and (not raw.endswith(b"\0") or b"\0\0" in raw):
            raise ValueError("Invalid NUL-delimited diff")
        paths = [os.fsdecode(path) for path in raw.split(b"\0")[:-1]]
        outputs, reason = classify_paths(paths)
        return outputs, f"{event_name}: {start}..{head}. {reason}"
    except (KeyError, TypeError, ValueError, OSError, subprocess.SubprocessError):
        return selection(
            ALL, "Diff unavailable or invalid event refs/data; running all consumers."
        )


def main():
    event_name = os.environ.get("GITHUB_EVENT_NAME", "")
    try:
        event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    except (KeyError, OSError, ValueError):
        outputs, reason = selection(
            ALL, "Event payload unavailable or invalid; running all consumers."
        )
    else:
        outputs, reason = select(event_name, event)
    output = "".join(
        f"{name}={str(value).lower()}\n" for name, value in outputs.items()
    )
    print(output, end="")
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as stream:
            stream.write(output)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as stream:
            stream.write(
                f"### CI dependency selector\n\n{reason}\n\n```text\n{output}```\n"
            )


if __name__ == "__main__":
    main()
