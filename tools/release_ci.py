"""Shared release workflow requirements and fail-closed result evaluation."""

import json
import sys

# Apple/packages are pinned reusable validations before tagging main, and direct
# PR runs before merging the version bump. The other consumers run on both.
REQUIRED_WORKFLOWS = {
    "API tests": ("pull_request", "push"),
    "Android": ("pull_request", "push"),
    "apple": ("pull_request",),
    "cross": ("pull_request", "push"),
    "Jules PR Review": ("pull_request",),
    "Maple package types": ("pull_request", "push"),
    "publish-package": ("pull_request",),
    "web": ("pull_request", "push"),
    "windows": ("pull_request", "push"),
}
# Their path filters exclude the version-only handoff diff. Missing runs are
# legitimate; a run that does exist must finish successfully, never skip.
PATH_FILTERED_WORKFLOWS = {"linux", "raw-pipeline"}


def waiting_for(runs, event):
    latest = {}
    for run in runs:  # GitHub returns newest first, including rerun attempts.
        latest.setdefault(run["name"], run)
    expected = {name for name, events in REQUIRED_WORKFLOWS.items() if event in events}
    present = (
        latest.keys() - {"release-handoff"}
        if event == "push"
        else latest.keys() & (expected | PATH_FILTERED_WORKFLOWS)
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
            [run for page in pages for run in page["workflow_runs"]], "pull_request"
        )
    except ValueError as error:
        print(f"::error::{error}")
        sys.exit(1)
    if waiting:
        print(f"Waiting for: {', '.join(waiting)}")
        sys.exit(2)
    print("All release workflows completed successfully.")
