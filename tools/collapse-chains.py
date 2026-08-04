#!/usr/bin/env python3
"""Collapse pass-through folder chains, applying the library naming rules.

A pass-through folder holds exactly one subfolder and no loose files, so it adds
depth without organising anything. This removes those layers and promotes what
they were wrapping, using the rules in ``passthrough_rules`` to decide which
chains may be touched and what the surviving folder should be called.

Nothing is deleted. Emptied wrappers move to a timestamped quarantine directory
carrying any ``.DS_Store`` or ``.maple`` they held, and the quarantine gets a
manifest plus a ``restore.sh`` that reverses the run.

Chains are applied deepest first. An inner collapse therefore finishes before
the outer one carries the result upward, which composes nested operations
without either having to know about the other: collapsing ``College`` after
``landscape and Becs/DCIM`` lands the files at ``2008/Grad School/landscape and
Becs`` on its own.

    tools/collapse-chains.py --root /Volumes/Photos/Library
    tools/collapse-chains.py --root /Volumes/Photos/Library --apply
"""

from __future__ import annotations

import argparse
import csv
import importlib.util
import os
import shlex
import shutil
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import passthrough_rules as rules  # noqa: E402

_spec = importlib.util.spec_from_file_location(
    "audit", os.path.join(HERE, "audit-single-child-folders.py")
)
audit = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(audit)

QUARANTINE_PREFIX = ".trash-collapsed-"
STAGING = "_staging"
WRAPPERS = "_wrappers"


def visible(directory: str) -> tuple[list[str], list[str], list[str]]:
    """Return ``(dirs, files, hidden)`` entry names for ``directory``."""
    dirs: list[str] = []
    files: list[str] = []
    hidden: list[str] = []
    with os.scandir(directory) as entries:
        for entry in entries:
            if entry.name.startswith("."):
                hidden.append(entry.name)
            elif entry.is_dir(follow_symlinks=False):
                dirs.append(entry.name)
            else:
                files.append(entry.name)
    return dirs, files, hidden


def build_plan(root: str, include_duplicates: bool) -> tuple[list[dict], list[dict]]:
    """Return ``(actionable, skipped)`` plan entries for ``root``."""
    actionable: list[dict] = []
    skipped: list[dict] = []
    for chain in audit.build_chains(root, include_duplicates):
        parent = os.path.dirname(os.path.relpath(chain["root"], root))
        terminal = os.path.relpath(chain["terminal"], root)
        links = [os.path.basename(x) for x in chain["links"]]
        entry = dict(
            src=terminal,
            chain_root=os.path.relpath(chain["root"], root),
            links=links,
            parent=parent,
            depth=chain["depth"],
            files=chain["terminal_files"],
        )
        reason = rules.skip_reason(terminal, parent, links)
        if reason:
            skipped.append({**entry, "reason": reason})
            continue
        name, why = rules.resolve_name(os.path.basename(terminal), links)
        actionable.append({**entry, "dest": os.path.join(parent, name), "why": why})

    # Deepest first, so an inner collapse completes before an outer one moves the
    # branch it lives on. Destinations stay as written against the current tree;
    # the ordering is what composes them.
    actionable.sort(key=lambda e: (-len(e["src"].split(os.sep)), e["src"]))
    return actionable, skipped


def still_valid(root: str, entry: dict) -> str | None:
    """Re-check ``entry`` against the live tree. Returns a reason to skip, or None."""
    chain_root = os.path.join(root, entry["chain_root"])
    terminal = os.path.join(root, entry["src"])
    if not os.path.isdir(chain_root) or not os.path.isdir(terminal):
        return "vanished since the scan"

    # Every link must still be a pass-through, or the shape has changed and the
    # destination we computed no longer describes this chain.
    current = chain_root
    for _ in entry["links"]:
        dirs, files, _hidden = visible(current)
        if len(dirs) != 1 or files:
            return "no longer a single-child chain"
        current = os.path.join(current, dirs[0])
    if os.path.normpath(current) != os.path.normpath(terminal):
        return "chain shape changed since the scan"
    return None


def collapse(root: str, entry: dict, quarantine: str, ops: list[tuple[str, str, str]]) -> str:
    """Perform one collapse. Returns a one-line description of what happened.

    The terminal is staged out first, then the emptied chain root is quarantined,
    then the staged folder takes its place. Going through staging is what makes
    the destination safe to equal the chain root or one of its links, which is
    the ordinary case: ``Iceland/Iceland`` and any rename that only changes
    letter case both land there.
    """
    terminal = os.path.join(root, entry["src"])
    destination = os.path.join(root, entry["dest"])
    stage_dir = os.path.join(quarantine, STAGING)
    os.makedirs(stage_dir, exist_ok=True)
    staged = os.path.join(stage_dir, f"{len(ops):05d}_{os.path.basename(entry['src'])}")

    shutil.move(terminal, staged)
    ops.append(("stage", entry["src"], os.path.relpath(staged, root)))

    # Wrappers are stored flat rather than as a mirrored tree. Nested chains
    # produce nested wrapper paths, and moving 2008/College to a quarantine path
    # the inner collapse already created would put it *inside* that directory
    # rather than at it, which then makes the reversal unrestorable.
    wrapper_dir = os.path.join(quarantine, WRAPPERS)
    os.makedirs(wrapper_dir, exist_ok=True)
    quarantined = os.path.join(
        wrapper_dir, f"{len(ops):05d}_{os.path.basename(entry['chain_root'])}"
    )
    shutil.move(os.path.join(root, entry["chain_root"]), quarantined)
    ops.append(("wrapper", entry["chain_root"], os.path.relpath(quarantined, root)))

    os.makedirs(os.path.dirname(destination) or root, exist_ok=True)
    if not os.path.exists(destination):
        shutil.move(staged, destination)
        ops.append(("place", os.path.relpath(staged, root), entry["dest"]))
        return f"{entry['src']}  ->  {entry['dest']}"

    # Something is already there: merge entry by entry so nothing is overwritten.
    dirs, files, hidden = visible(staged)
    for name in sorted(dirs + files):
        target = os.path.join(destination, name)
        if os.path.exists(target):
            raise FileExistsError(f"{entry['dest']}/{name} already exists")
        shutil.move(os.path.join(staged, name), target)
        ops.append(("merge", os.path.join(os.path.relpath(staged, root), name),
                    os.path.join(entry["dest"], name)))
    return f"{entry['src']}  ->  {entry['dest']}  (merged {len(dirs) + len(files)} entries)"


def write_restore(root: str, quarantine: str, ops: list[tuple[str, str, str]]) -> str:
    """Write ``restore.sh`` reversing ``ops`` in order.

    Each move is guarded at the point it runs rather than all of them up front.
    A blanket preflight cannot work here: the ops form a dependent sequence, so
    a collapse that kept its own name leaves the destination sitting exactly
    where the original chain root was, and only the preceding reverse step
    vacates it. ``undo`` reports the step it stopped on so a partial reversal is
    visible rather than silent.
    """
    path = os.path.join(quarantine, "restore.sh")
    lines = [
        "#!/bin/bash",
        "# Undo the collapse run that created this directory.",
        "# Generated by tools/collapse-chains.py",
        "#",
        "# Moves are reversed in order, each checked as it runs. If one fails the",
        "# script stops and says which, leaving the earlier ones reversed.",
        "set -uo pipefail",
        f"cd {shlex.quote(root)}",
        "",
        "step=0",
        "undo() {  # undo <from> <to>",
        "    step=$((step + 1))",
        '    if [ ! -e "$1" ]; then',
        '        echo "step $step: expected $1 to exist; stopping." >&2; exit 1',
        "    fi",
        '    if [ -e "$2" ]; then',
        '        echo "step $step: $2 is occupied; stopping." >&2; exit 1',
        "    fi",
        '    mkdir -p "$(dirname "$2")"',
        '    mv "$1" "$2"',
        "}",
        "",
    ]
    for _kind, src, dst in reversed(ops):
        lines.append(f"undo {shlex.quote(dst)} {shlex.quote(src)}")
    lines += ["", f'echo "Reversed {len(ops)} moves."', ""]
    with open(path, "w") as fh:
        fh.write("\n".join(lines))
    os.chmod(path, 0o755)
    return path


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Collapse pass-through folder chains using the library naming rules.",
        epilog="Dry run by default. Pass --apply to move anything.",
    )
    parser.add_argument("--root", required=True, help="library root, e.g. /Volumes/Photos-1")
    parser.add_argument("--apply", action="store_true", help="perform the moves")
    parser.add_argument("--limit", type=int, help="only act on the first N chains")
    parser.add_argument(
        "--no-include-duplicates", dest="include_duplicates", action="store_false",
        help="skip the _duplicates/ tree",
    )
    args = parser.parse_args()

    root = os.path.realpath(args.root)
    if not os.path.isdir(root):
        print(f"error: {args.root} is not a directory (is the volume mounted?)", file=sys.stderr)
        return 1

    print(f"Scanning {root} ...")
    actionable, skipped = build_plan(root, args.include_duplicates)
    if args.limit is not None:
        actionable = actionable[: args.limit]

    print(f"\n{len(actionable)} to collapse, {len(skipped)} left alone by rule\n")
    for entry in actionable[:400]:
        print(f"  {entry['src']}\n    -> {entry['dest']}   [{entry['why']}]")
    if len(actionable) > 400:
        print(f"  ... and {len(actionable) - 400} more")

    if not args.apply:
        print("\nDry run -- nothing was touched. Re-run with --apply.")
        return 0
    if not actionable:
        return 0

    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    quarantine = os.path.join(root, f"{QUARANTINE_PREFIX}{stamp}")
    os.makedirs(quarantine, exist_ok=False)
    print(f"\nQuarantine: {quarantine}\n")

    ops: list[tuple[str, str, str]] = []
    done = 0
    blocked: list[tuple[str, str]] = []
    for entry in actionable:
        reason = still_valid(root, entry)
        if reason:
            blocked.append((entry["src"], reason))
            continue
        try:
            print(f"  {collapse(root, entry, quarantine, ops)}")
            done += 1
        except (OSError, FileExistsError) as exc:
            blocked.append((entry["src"], f"failed: {exc}"))

    stage_dir = os.path.join(quarantine, STAGING)
    if os.path.isdir(stage_dir) and not os.listdir(stage_dir):
        os.rmdir(stage_dir)

    if ops:
        with open(os.path.join(quarantine, "manifest.tsv"), "w", newline="") as fh:
            writer = csv.writer(fh, delimiter="\t", lineterminator="\n")
            writer.writerow(["kind", "from", "to"])
            writer.writerows(ops)
        restore = write_restore(root, quarantine, ops)
        print(f"\nCollapsed {done} chains in {len(ops)} moves.")
        print(f"Undo everything:  bash {shlex.quote(restore)}")
        print(f"Accept everything: rm -rf {shlex.quote(quarantine)}")
    else:
        os.rmdir(quarantine)
        print("\nNothing moved; removed the empty quarantine directory.")

    if blocked:
        print(f"\nSkipped {len(blocked)}:")
        for src, why in blocked:
            print(f"    {src}  -- {why}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
