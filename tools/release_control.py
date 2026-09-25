"""Trusted release orchestration; GitHub writes only in explicit CLI commands."""

import argparse
import json
import os
import subprocess
import tempfile
from pathlib import Path

from release_handoff import (
    CONTEXT,
    allowed_pr,
    branch,
    git,
    next_version,
    semver,
    validate_bump,
    validate_versions,
    version,
    version_files,
)


def run(*args, **kwargs):
    return subprocess.check_output(args, text=True, **kwargs).strip()


def api(repo, endpoint, payload=None):
    args = ["gh", "api", f"repos/{repo}/{endpoint}"]
    if payload is not None:
        args += ["--method", "POST", "--input", "-"]
    environment = os.environ.copy()
    if endpoint.startswith("statuses/") and environment.get("GH_STATUS_TOKEN"):
        environment["GH_TOKEN"] = environment["GH_STATUS_TOKEN"]
    return json.loads(
        run(
            *args,
            input=json.dumps(payload) if payload is not None else None,
            env=environment,
        )
    )


def open_prs(repo):
    pages = json.loads(
        run(
            "gh",
            "api",
            "--paginate",
            "--slurp",
            f"repos/{repo}/pulls?state=open&base=main&per_page=100",
        )
    )
    return [pr for page in pages for pr in page]


def ref_exists(ref):
    return (
        subprocess.run(
            ["git", "show-ref", "--verify", "--quiet", ref], check=False
        ).returncode
        == 0
    )


def refresh_refs():
    # Explicit refspec covers branches created since checkout, including handoff refs.
    run(
        "git",
        "fetch",
        "origin",
        "--prune",
        "--tags",
        "+refs/heads/*:refs/remotes/origin/*",
    )


def remote_tag(tag):
    refs = dict(
        reversed(line.split())
        for line in run(
            "git", "ls-remote", "origin", f"refs/tags/{tag}", f"refs/tags/{tag}^{{}}"
        ).splitlines()
    )
    return refs.get(f"refs/tags/{tag}^{{}}", refs.get(f"refs/tags/{tag}"))


def status(repo, pr, state, description):
    payload = {"state": state, "context": CONTEXT, "description": description}
    sha = pr["head"]["sha"]
    # The combined endpoint returns the latest status for each context. Do not
    # consume GitHub's 1,000-status allowance merely to change the run URL.
    page = 1
    while True:
        current = api(repo, f"commits/{sha}/status?per_page=100&page={page}")
        previous = next(
            (item for item in current["statuses"] if item["context"] == CONTEXT), None
        )
        if previous or len(current["statuses"]) < 100:
            break
        page += 1
    if (
        previous
        and previous["state"] == state
        and previous.get("description") == description
        and previous.get("creator", {}).get("login") == "github-actions[bot]"
    ):
        return
    if os.environ.get("GITHUB_RUN_ID"):
        payload["target_url"] = (
            f"https://github.com/{repo}/actions/runs/{os.environ['GITHUB_RUN_ID']}"
        )
    api(repo, f"statuses/{sha}", payload)


def refresh_gate(repo):
    refresh_refs()
    main = git("rev-parse", "origin/main")
    current = version(main)
    marker = f"refs/remotes/origin/{branch(current)}"
    handoff = git("rev-parse", marker) if ref_exists(marker) else None
    tag = f"refs/tags/v{current}"
    published = remote_tag(f"v{current}")
    tagged = published is not None
    valid = False
    if handoff:
        try:
            validate_bump(main, handoff)
            valid = (
                tagged
                and git("rev-parse", f"{tag}^{{commit}}") == published
                and subprocess.run(
                    ["git", "merge-base", "--is-ancestor", f"{tag}^{{commit}}", main],
                    check=False,
                ).returncode
                == 0
            )
        except (ValueError, subprocess.CalledProcessError) as error:
            print(f"Invalid handoff (keeping gate closed): {error}")
    # Old already-released main versions also fail closed, requiring a migration bump.
    active = handoff is not None or tagged
    decisions = {}
    for pr in open_prs(repo):
        allowed = not active or (valid and allowed_pr(pr, main, handoff, tagged))
        sha = pr["head"]["sha"]
        previous = decisions.get(sha, (pr, True))[1]
        decisions[sha] = (pr, previous and allowed)
    failures = []
    for pr, allowed in decisions.values():
        try:
            status(
                repo,
                pr,
                "success" if allowed else "pending",
                "Handoff complete or approved version bump"
                if allowed
                else f"Waiting for the next-version PR after v{current}",
            )
        except (subprocess.CalledProcessError, ValueError, RuntimeError) as error:
            failures.append(pr["head"]["sha"])
            print(f"Status refresh failed for {failures[-1]}: {error}")
    if failures:
        raise RuntimeError(f"Handoff status refresh incomplete: {', '.join(failures)}")


def require_gate(repo):
    rules = api(repo, "rules/branches/main")
    checks = [
        check["context"]
        for rule in rules
        if rule["type"] == "required_status_checks"
        for check in rule["parameters"]["required_status_checks"]
    ]
    if CONTEXT not in checks:
        raise ValueError(
            f"Require {CONTEXT} in the Main ruleset before creating releases"
        )


def require_release_validation(sha):
    for name in ("VALIDATED_APPLE_SHA", "VALIDATED_PACKAGES_SHA"):
        if os.environ.get(name) != sha:
            raise ValueError(f"{name} must attest successful validation of {sha}")


def require_green_main(repo, sha):
    # Apple and native-package validation run as pinned reusable prerequisites
    # of create-release; these are the remaining main-push checks.
    pages = json.loads(
        run(
            "gh",
            "api",
            "--paginate",
            "--slurp",
            f"repos/{repo}/actions/runs?head_sha={sha}&event=push&per_page=100",
        )
    )
    latest = {}
    for page in pages:
        for workflow in page["workflow_runs"]:
            latest.setdefault(workflow["name"], workflow)
    expected = {"API tests", "cross", "web", "windows", "Maple package types"}
    missing = expected - latest.keys()
    if missing:
        raise ValueError(f"Missing main CI: {sorted(missing)}")
    for name, workflow in latest.items():
        # This controller can itself be the current push-triggered run.
        if name == "release-handoff":
            continue
        if workflow["status"] != "completed" or workflow["conclusion"] != "success":
            raise ValueError(f"main CI is not green: {name}: {workflow['html_url']}")


def handoff_issue(repo, tag):
    issues = json.loads(
        run(
            "gh",
            "issue",
            "list",
            "--repo",
            repo,
            "--state",
            "all",
            "--limit",
            "100",
            "--json",
            "number,title",
        )
    )
    title = f"Start development after {tag}"
    matching = [issue for issue in issues if issue["title"] == title]
    issue = (
        str(matching[0]["number"])
        if matching
        else run(
            "gh",
            "issue",
            "create",
            "--repo",
            repo,
            "--title",
            title,
            "--body",
            f"Advance all product versions after releasing {tag}; keep TestFlight on the next development version.",
        ).rsplit("/", 1)[-1]
    )
    return issue


def release(repo, requested, advance_only=False, release_sha=None):
    require_gate(repo)
    refresh_refs()
    main = git("rev-parse", "origin/main")
    pinned = release_sha or main
    if pinned != main:
        original = version(pinned)
        published_original = remote_tag(f"v{original}")
        if (
            published_original
            and semver(version(main)) > semver(original)
            and all(
                subprocess.run(
                    ["git", "merge-base", "--is-ancestor", ref, main], check=False
                ).returncode
                == 0
                for ref in (pinned, published_original)
            )
        ):
            print(f"Handoff for v{original} already completed; no new release created.")
            return
        raise ValueError(
            "main moved since this dispatch. Start a new dispatch on main; reruns never select a new release commit."
        )
    current = version(main)
    tag = f"v{current}"
    tag_ref = f"refs/tags/{tag}"
    published = remote_tag(tag)
    if advance_only and (
        not published
        or subprocess.run(
            ["git", "merge-base", "--is-ancestor", f"{tag_ref}^{{commit}}", main],
            check=False,
        ).returncode
        != 0
    ):
        raise ValueError(
            "Advance-only requires the current version's existing tag in main's history"
        )
    if not advance_only and published and published != main:
        raise ValueError(
            f"{tag} already exists on another commit. Merge a next-version migration PR first; never move the tag."
        )
    validate_versions(main)
    require_release_validation(main)
    require_green_main(repo, main)
    issue = handoff_issue(repo, tag)
    name = branch(current)
    marker = f"refs/remotes/origin/{name}"
    marker_head = git("rev-parse", marker) if ref_exists(marker) else None
    if marker_head:
        validate_bump(git("rev-parse", f"{marker_head}^"), marker_head)
    repair = (
        marker_head
        and git("rev-parse", f"{marker_head}^") != main
        and (advance_only or not published)
    )
    if marker_head and not repair:
        head = git("rev-parse", marker)
        validate_bump(main, head)
        if git("rev-parse", f"{head}^") != main:
            raise ValueError(
                "main moved during setup; repair the handoff branch before retrying"
            )
        if requested and version(head) != next_version(current, requested):
            raise ValueError("Retry must use the existing handoff's next version")
    else:
        new = next_version(
            current, requested or (version(marker_head) if repair else "")
        )
        run("git", "checkout", "--detach", main)
        run("bash", "tools/sync-release-version.sh", new)
        run("bun", "install", cwd="src/maple")
        run("bun", "run", "build", cwd="src/maple")
        run("git", "add", "--", *version_files(main))
        run("git", "commit", "-m", f"chore(release): start {new} development")
        run("git", "diff", "--exit-code")
        head = git("rev-parse", "HEAD")
        validate_bump(main, head)
        # The branch is the durable lock, even if tag/PR creation fails later.
        lease = (
            [f"--force-with-lease=refs/heads/{name}:{marker_head}"] if repair else []
        )
        run("git", "push", *lease, "origin", f"{head}:refs/heads/{name}")
    refresh_gate(repo)
    if api(repo, "git/ref/heads/main")["object"]["sha"] != main:
        raise ValueError("main moved during release setup; no tag was created")
    if not advance_only and not published:
        if not ref_exists(tag_ref):
            run("git", "tag", "-a", tag, main, "-m", f"Maple {tag}")
        if git("rev-parse", f"{tag_ref}^{{commit}}") != main:
            raise ValueError(
                "Existing local tag points elsewhere; refusing to publish it"
            )
        run("git", "push", "origin", tag_ref)
    if remote_tag(tag) != git("rev-parse", f"{tag_ref}^{{commit}}"):
        raise ValueError("Release tag was not published at the expected commit")
    # Never turn this into an auto-tag-on-merge flow: the release is already pinned.
    existing = [
        pr
        for pr in open_prs(repo)
        if pr["head"]["ref"] == name
        and pr["head"]["repo"]
        and pr["head"]["repo"]["full_name"] == repo
    ]
    if existing:
        url = existing[0]["html_url"]
    else:
        with tempfile.TemporaryDirectory() as directory:
            body = Path(directory) / "body.md"
            released_sha = git("rev-parse", f"{tag_ref}^{{commit}}")
            body.write_text(
                f"Start **{version(head)}** development after **{tag}**.\n\nThe release tag is already pinned to `{released_sha}`. This version-only PR unblocks main and starts TestFlight on the next version; merging it does not create a release.\n\nCloses #{issue}\n"
            )
            url = run(
                "gh",
                "pr",
                "create",
                "--repo",
                repo,
                "--base",
                "main",
                "--head",
                name,
                "--title",
                f"chore(release): start {version(head)} development",
                "--body-file",
                str(body),
            )
    refresh_gate(repo)
    print(f"Release {tag}: {remote_tag(tag)}\nNext-version PR: {url}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["release", "gate", "advance"])
    parser.add_argument(
        "--repo",
        default=os.environ.get("GITHUB_REPOSITORY"),
        required=not os.environ.get("GITHUB_REPOSITORY"),
    )
    parser.add_argument("--next-version", default="")
    parser.add_argument("--release-sha", default=os.environ.get("GITHUB_SHA"))
    args = parser.parse_args()
    if args.command == "gate":
        refresh_gate(args.repo)
    else:
        release(
            args.repo,
            args.next_version,
            advance_only=args.command == "advance",
            release_sha=args.release_sha,
        )
