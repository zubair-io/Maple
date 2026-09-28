"""Conservative heavy-CI selector; uncertainty always selects every consumer."""

import json
import os
import re
import subprocess
from pathlib import Path

CONSUMERS = ("windows", "web", "api", "maple", "codegen")
ALL = frozenset(CONSUMERS)
CODEGEN_DOCS = frozenset(
    f"docs/{name}.{extension}"
    for name in ("capability-registry", "camera-support")
    for extension in ("md", "json")
)
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
    if path.startswith(("tools/release_", "tools/test_release_")):
        return frozenset()
    if path.startswith((".github/workflows/", ".github/actions/")) or any(
        part in ("scripts", "ci_scripts") for part in parts[:-1]
    ):
        return ALL
    if path.startswith(("src/raw-pipeline/", "test-fixtures/", "tools/qualification/")):
        return ALL
    if path.startswith("src/apple/MapleUITests/Goldens/.calibration/"):
        return ALL
    if path == (
        "src/apple/Packages/MapleCore/Sources/MapleCore/Resources/builtin-presets.json"
    ):
        return {"api", "maple", "web", "codegen"}
    if path.startswith(
        (
            "src/apple/Maple/Assets.xcassets/AppIcon.appiconset/",
            "src/apple/Maple/Assets.xcassets/LaunchLogo.imageset/",
        )
    ):
        return {"web", "codegen"}
    if path.startswith("docs/design/maple-ui/components/"):
        return {"web"}
    generated = "generated" in path.lower().split("/") or path.endswith(
        (".generated.ts", ".g.cs")
    )
    codegen = (
        {"codegen"}
        if generated or path == "src/api/src/routes/xmp.sidecar-contract.test.ts"
        else set()
    )
    if path.startswith(("src/api/", "src/maple/")):
        return {"api", "maple", "web"} | codegen
    if path.startswith("src/web/"):
        return {"api", "web"} | codegen
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
    if path.startswith("src/apple/") or path in CODEGEN_DOCS:
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
