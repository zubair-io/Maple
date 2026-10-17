"""Shared release workflow requirements and fail-closed result evaluation."""

import json
import re
import sys

# #4951 adds the twelve merge_group CI triggers; #4614 enables the queue only
# after that prerequisite and this release gate have landed and been verified.
# Apple/packages are pinned reusable validations before tagging main, and direct
# PR runs before merging the version bump. The other consumers run on both.
REQUIRED_WORKFLOWS = {
    "API tests": ("pull_request", "push", "merge_group"),
    "Android": ("pull_request", "push", "merge_group"),
    "apple": ("pull_request", "merge_group"),
    "cross": ("pull_request", "push", "merge_group"),
    "Jules PR Review": ("pull_request",),
    "Maple package types": ("pull_request", "push", "merge_group"),
    "publish-package": ("pull_request", "merge_group"),
    "web": ("pull_request", "push", "merge_group"),
    "windows": ("pull_request", "push", "merge_group"),
    "cloudflare": ("merge_group",),
    "face-clustering": ("merge_group",),
    "linux": ("merge_group",),
    "raw-pipeline": ("merge_group",),
}
# Their path filters exclude the version-only handoff diff. Missing runs are
# legitimate; a run that does exist must finish successfully, never skip.
PATH_FILTERED_WORKFLOWS = {"linux", "raw-pipeline"}


def waiting_for(runs, event, sha=None):
    if event == "merge_group" and not (sha and re.fullmatch(r"[0-9a-f]{40}", sha)):
        raise ValueError("Merge-group readiness requires its exact commit SHA")
    latest = {}
    for run in runs:  # GitHub returns newest first, including rerun attempts.
        if event == "merge_group" and (
            run.get("head_sha") != sha or run.get("event") != event
        ):
            continue
        latest.setdefault(run["name"], run)
    expected = {name for name, events in REQUIRED_WORKFLOWS.items() if event in events}
    present = (
        latest.keys() - {"release-handoff"}
        if event == "push"
        else latest.keys()
        & (expected | (PATH_FILTERED_WORKFLOWS if event == "pull_request" else set()))
    )
    waiting = []
    for name in sorted(expected | present):
        workflow = latest.get(name)
        if workflow is None:
            waiting.append(f"{name} (not started)")
        elif workflow["status"] != "completed":
            waiting.append(f"{name} ({workflow['status']})")
        elif workflow.get("conclusion") != "success":
            raise ValueError(
                f"{name} completed with {workflow.get('conclusion')}: "
                f"{workflow.get('html_url', '')}"
            )
    return waiting


if __name__ == "__main__":
    pages = json.load(sys.stdin)
    try:
        waiting = waiting_for(
            [run for page in pages for run in page["workflow_runs"]],
            sys.argv[1] if len(sys.argv) > 1 else "pull_request",
            sys.argv[2] if len(sys.argv) > 2 else None,
        )
    except ValueError as error:
        print(f"::error::{error}")
        sys.exit(1)
    if waiting:
        print(f"Waiting for: {', '.join(waiting)}")
        sys.exit(2)
    print("All release workflows completed successfully.")
