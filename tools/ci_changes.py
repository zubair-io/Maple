"""Conservative heavy-CI selector; uncertainty always selects every consumer."""

import json
import os
import re
import subprocess
from pathlib import Path

CONSUMERS = ("windows", "web", "api", "maple", "codegen")
ALL = frozenset(CONSUMERS)
WORKFLOWS = (
    "apple",
    "linux",
    "raw_pipeline",
    "publish_package",
    "cloudflare",
    "face_clustering",
)
ALL_OUTPUTS = (*CONSUMERS, *WORKFLOWS)
ALL_WORKFLOWS = frozenset(WORKFLOWS)
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


def selection(consumers, reason, workflows=ALL_WORKFLOWS):
    selected = {name: name in consumers for name in CONSUMERS}
    selected.update({name: name in workflows for name in WORKFLOWS})
    return selected, reason


def under(path, roots):
    return any(path == root.rstrip("/") or path.startswith(root) for root in roots)


def workflow_dependencies(path):
    """Select path-scoped CI workflows for a merge-group validation."""
    if not path or any(part in ("", ".", "..") for part in path.split("/")):
        return ALL_WORKFLOWS

    selected = set()
    if under(
        path,
        (
            "src/apple/",
            "src/api/",
            "src/raw-pipeline/",
            ".github/swift-regressions/",
            "src/web/e2e/recipe-interchange/",
        ),
    ) or path in {
        ".github/workflows/apple.yml",
        "tools/check-swift-regressions-coverage.py",
        "src/scripts/test_export_recipe_interchange.sh",
        "src/scripts/qualification/recipe-interchange.swift",
        "test-fixtures/export-recipes/interchange-cases.json",
        "src/web/playwright.recipe-interchange.config.ts",
        "src/web/projects/maple-common/src/lib/export/export-recipe-store.ts",
        "src/web/projects/maple-common/src/lib/generated/export-recipe.generated.ts",
        "src/web/package.json",
        "src/web/bun.lock",
    }:
        selected.add("apple")

    if under(
        path,
        (
            "src/linux/",
            "tools/qualification/linux-native/",
            "src/raw-pipeline/",
            "resources/film-luts/",
            "test-fixtures/batch-transfer/",
            "test-fixtures/jpeg-tiff/",
            "src/apple/MapleUITests/Fixtures/synthetic/",
        ),
    ) or path in {
        ".github/workflows/linux.yml",
        "src/apple/Maple/Assets.xcassets/AppIcon.appiconset/maple512.png",
    }:
        selected.add("linux")

    if under(
        path,
        (
            "src/raw-pipeline/",
            "src/scripts/acr-reference/",
            "test-fixtures/tone-whites/",
            "test-fixtures/tone-exposure/",
            "test-fixtures/qualification/",
            "tools/qualification/",
        ),
    ) or path in {
        ".github/workflows/raw-pipeline.yml",
        "test-fixtures/budgets.json",
        "test-fixtures/pano-budgets.json",
        "test-fixtures/banding_budgets.json",
        "src/scripts/check_wgsl.sh",
        "src/scripts/lens_warp_diff.py",
        "src/scripts/test_lensfun_vs_lcp.sh",
        "src/scripts/compare_images.py",
        "src/scripts/compare_images_test.py",
        "src/scripts/test_pano_pipeline.sh",
        "src/scripts/pano_metrics.py",
        "src/scripts/test_synthetic_grey.sh",
        "src/scripts/test_synthetic_color_chart.sh",
        "src/scripts/test_grey_adjustments.sh",
        "src/scripts/test_tone_exposure.sh",
        "src/scripts/test_tone_whites.sh",
        "tools/tone_whites_gate.py",
        "tools/test_tone_whites_gate.py",
        "tools/tone_exposure_gate.py",
        "tools/tone_sprint_report.py",
        "src/scripts/test_grey_dcp.sh",
        "src/scripts/test_banding.sh",
        "src/scripts/banding_check.py",
        "src/scripts/banding_check_test.py",
        "src/scripts/halo_check.py",
        "src/scripts/hue_stability.py",
        "src/scripts/halo_check_test.py",
        "src/scripts/test_diagnostic_evidence.py",
        "src/scripts/test_halo_detection.sh",
        "src/scripts/test_hue_stability.sh",
    } or path.startswith("src/scripts/stage_stats") or path.startswith(
        "src/scripts/stage_diff"
    ):
        selected.add("raw_pipeline")

    if under(path, ("src/maple/", "src/raw-pipeline/")) or path in {
        ".github/workflows/publish-package.yml",
        "tools/native_package_cache.py",
    } or path.startswith("tools/test_ci_native") or under(
        path, ("src/apple/MapleUITests/Goldens/.calibration/",)
    ):
        selected.add("publish_package")

    if under(path, ("src/cloudflare/",)) or path == ".github/workflows/cloudflare.yml":
        selected.add("cloudflare")

    if under(path, ("src/api/src/people/", "test-fixtures/face-clustering/")) or path in {
        ".github/workflows/face-clustering.yml",
        "src/scripts/test_face_clustering.sh",
    }:
        selected.add("face_clustering")

    # Unknown source and workflow paths select every scoped workflow. Known
    # documentation and release-controller files have no subsystem consumer.
    if not selected and not (
        path.startswith("docs/")
        or path in METADATA
        or path.startswith(("tools/release_", "tools/test_release_"))
    ):
        return ALL_WORKFLOWS
    return frozenset(selected)


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
        return selection(
            ALL,
            "Empty diff; conservatively running all consumers and scoped workflows.",
        )
    consumers = frozenset().union(*(dependencies(path) for path in paths))
    workflows = frozenset().union(*(workflow_dependencies(path) for path in paths))
    return selection(
        consumers,
        f"Classified {len(paths)} changed paths using conservative dependency rules "
        "(unknown paths select all consumers and scoped workflows).",
        workflows,
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
    if event_name not in ("pull_request", "push", "merge_group"):
        return selection(
            ALL,
            "Manual, reusable, or unknown event; running all consumers and scoped workflows.",
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
        elif event_name == "merge_group":
            group = event["merge_group"]
            base = valid_sha(group["base_sha"])
            head = valid_sha(group["head_sha"])
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
