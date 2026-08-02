#!/usr/bin/env python3
"""Quarantine photo-library folders that hold no media.

After photos are moved around, folders are left behind holding nothing but an
empty ``.maple/`` cache directory, orphaned ``.xmp`` sidecars, and OS junk like
``.DS_Store``. This finds those folders and moves them into a timestamped
quarantine directory at the library root.

Nothing is ever deleted. Removal is a move, and the quarantine directory gets a
manifest plus a generated ``restore.sh`` so the whole run can be undone with one
command. Once you are satisfied, delete the quarantine directory yourself.

The safety invariant: a folder is a candidate only if a full recursive walk of
its subtree finds zero files that are not ``.xmp`` sidecars or dotfiles. Any
other file, of any extension and any size, at any depth, disqualifies that
folder and every one of its ancestors.

Dry run (prints the plan, touches nothing):

    tools/cleanup-empty-folders.py

Execute:

    tools/cleanup-empty-folders.py --apply
"""

from __future__ import annotations

import argparse
import os
import shlex
import shutil
import sys
from datetime import datetime, timezone

DEFAULT_ROOT = "/Volumes/Photos-1"
QUARANTINE_PREFIX = ".trash-empty-dirs-"

# Files that do not count as content. Everything else does.
SIDECAR_EXTS = {".xmp"}


def is_disposable(filename: str) -> bool:
    """True if this file does not, on its own, justify keeping a folder."""
    if filename.startswith("."):
        return True
    return os.path.splitext(filename)[1].lower() in SIDECAR_EXTS


def has_dot_component(relpath: str) -> bool:
    """True if any path segment is hidden, e.g. ``.maple`` or ``a/.coral/b``."""
    return any(part.startswith(".") for part in relpath.split(os.sep))


def count_content_files(directory: str) -> int:
    """Recursively count files in ``directory`` that are not disposable.

    Used both for the initial survey and for the immediately-before-move
    re-verification, so the two can never disagree about what "empty" means.
    """
    total = 0
    for _, _, filenames in os.walk(directory, followlinks=False):
        total += sum(1 for fn in filenames if not is_disposable(fn))
    return total


def describe(directory: str) -> tuple[str, int, int]:
    """Return ``(class, xmp_count, other_file_count)`` for a candidate."""
    xmps = 0
    others = 0
    has_maple = False
    has_subdirs = False
    for _, dirnames, filenames in os.walk(directory, followlinks=False):
        has_subdirs = has_subdirs or bool(dirnames)
        has_maple = has_maple or ".maple" in dirnames
        for fn in filenames:
            if not fn.startswith(".") and os.path.splitext(fn)[1].lower() in SIDECAR_EXTS:
                xmps += 1
            else:
                others += 1

    label = (
        "maple + orphaned xmp"
        if xmps and has_maple
        else "orphaned xmp only"
        if xmps
        else "empty .maple only"
        if has_maple
        else "dotfiles only"
        if others
        else "empty subdirs only"
        if has_subdirs
        else "completely empty"
    )
    return label, xmps, others


def find_candidates(root: str, include_duplicates: bool) -> list[str]:
    """Absolute paths of maximal media-free folders under ``root``.

    Walks bottom-up so each directory's subtree total is already known by the
    time we reach it. "Maximal" means a folder whose parent is also media-free
    is dropped, so an empty ``2024/12`` moves once instead of as four separate
    day folders.
    """
    content_counts: dict[str, int] = {}
    media_free: set[str] = set()

    for dirpath, dirnames, filenames in os.walk(root, topdown=False, followlinks=False):
        own = sum(1 for fn in filenames if not is_disposable(fn))
        below = sum(content_counts.get(os.path.join(dirpath, d), 0) for d in dirnames)
        content_counts[dirpath] = own + below
        if own + below == 0 and dirpath != root:
            media_free.add(dirpath)

    def eligible(path: str) -> bool:
        rel = os.path.relpath(path, root)
        if has_dot_component(rel):
            # Never target app-managed caches (.maple, .coral, .Trashes) or a
            # previous run's quarantine. A .maple inside a candidate still
            # travels with its parent -- it just is not a target itself.
            return False
        if not include_duplicates and rel.split(os.sep)[0] == "_duplicates":
            return False
        # Maximal only: drop anything whose parent is also going away.
        return os.path.dirname(path) not in media_free

    return sorted(p for p in media_free if eligible(p))


def print_plan(root: str, entries: list[tuple[str, str, int, int]]) -> None:
    """Print the grouped plan. ``entries`` is ``(path, class, xmps, others)``."""
    if not entries:
        print("Nothing to do: no media-free folders found.")
        return

    by_class: dict[str, list[tuple[str, int, int]]] = {}
    for path, label, xmps, others in entries:
        by_class.setdefault(label, []).append((path, xmps, others))

    for label in sorted(by_class):
        rows = by_class[label]
        print(f"\n{label}  ({len(rows)} folder{'s' if len(rows) != 1 else ''})")
        for path, xmps, others in rows:
            counts = []
            if xmps:
                counts.append(f"{xmps} xmp")
            if others:
                counts.append(f"{others} other")
            suffix = f"   [{', '.join(counts)}]" if counts else ""
            print(f"    {os.path.relpath(path, root)}{suffix}")

    total_xmp = sum(e[2] for e in entries)
    total_other = sum(e[3] for e in entries)
    print(
        f"\n{len(entries)} folders, carrying {total_xmp} orphaned .xmp "
        f"and {total_other} other files."
    )


def write_restore_script(quarantine: str, moves: list[tuple[str, str]]) -> str:
    """Write ``restore.sh`` that puts every moved folder back where it was."""
    path = os.path.join(quarantine, "restore.sh")
    lines = [
        "#!/bin/bash",
        "# Undo the cleanup run that created this directory.",
        "# Generated by tools/cleanup-empty-folders.py -- run from anywhere.",
        "set -euo pipefail",
        "",
    ]
    for original, quarantined in moves:
        lines.append(f"mkdir -p {shlex.quote(os.path.dirname(original))}")
        lines.append(f"mv {shlex.quote(quarantined)} {shlex.quote(original)}")
    lines.append("")
    lines.append('echo "Restored %d folders."' % len(moves))
    lines.append("")

    with open(path, "w") as fh:
        fh.write("\n".join(lines))
    os.chmod(path, 0o755)
    return path


def write_manifest(quarantine: str, moves: list[tuple[str, str]]) -> str:
    """Write a TSV of original -> quarantined paths."""
    path = os.path.join(quarantine, "manifest.tsv")
    with open(path, "w") as fh:
        fh.write("original_path\tquarantined_path\n")
        for original, quarantined in moves:
            fh.write(f"{original}\t{quarantined}\n")
    return path


def apply_moves(root: str, entries: list[tuple[str, str, int, int]]) -> int:
    """Move each folder into a fresh quarantine directory. Returns exit code."""
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    quarantine = os.path.join(root, f"{QUARANTINE_PREFIX}{stamp}")
    os.makedirs(quarantine, exist_ok=False)
    print(f"\nQuarantine: {quarantine}\n")

    moves: list[tuple[str, str]] = []
    skipped: list[tuple[str, str]] = []

    for path, _, _, _ in entries:
        rel = os.path.relpath(path, root)

        # Re-verify immediately before moving. The survey may be minutes old on
        # a network volume, and this is the last chance to catch a folder that
        # gained a file in the meantime.
        if not os.path.isdir(path):
            skipped.append((rel, "vanished since the scan"))
            continue
        remaining = count_content_files(path)
        if remaining:
            skipped.append((rel, f"gained {remaining} file(s) since the scan"))
            continue

        destination = os.path.join(quarantine, rel)
        os.makedirs(os.path.dirname(destination), exist_ok=True)
        try:
            shutil.move(path, destination)
        except OSError as exc:
            skipped.append((rel, f"move failed: {exc}"))
            continue
        moves.append((path, destination))
        print(f"  moved  {rel}")

    if moves:
        write_manifest(quarantine, moves)
        restore = write_restore_script(quarantine, moves)
        print(f"\nMoved {len(moves)} folders.")
        print(f"Undo everything:  bash {shlex.quote(restore)}")
        print(f"Accept everything: rm -rf {shlex.quote(quarantine)}")
    else:
        os.rmdir(quarantine)
        print("\nMoved nothing; removed the empty quarantine directory.")

    if skipped:
        print(f"\nSkipped {len(skipped)}:")
        for rel, why in skipped:
            print(f"    {rel}  -- {why}")

    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Quarantine photo-library folders that hold no media.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Dry run by default. Pass --apply to actually move anything.",
    )
    parser.add_argument("--root", default=DEFAULT_ROOT, help=f"library root (default: {DEFAULT_ROOT})")
    parser.add_argument("--apply", action="store_true", help="move the folders (default: dry run)")
    parser.add_argument(
        "--no-include-duplicates",
        dest="include_duplicates",
        action="store_false",
        help="skip the _duplicates/ tree",
    )
    parser.add_argument("--limit", type=int, help="only act on the first N folders")
    args = parser.parse_args()

    root = os.path.realpath(args.root)
    if not os.path.isdir(root):
        print(f"error: {args.root} is not a directory (is the volume mounted?)", file=sys.stderr)
        return 1

    print(f"Scanning {root} ...")
    candidates = find_candidates(root, args.include_duplicates)
    entries = [(p, *describe(p)) for p in candidates]
    if args.limit is not None:
        entries = entries[: args.limit]

    print_plan(root, entries)
    if not entries:
        return 0

    if not args.apply:
        print("\nDry run -- nothing was touched. Re-run with --apply to move these.")
        return 0

    return apply_moves(root, entries)


if __name__ == "__main__":
    sys.exit(main())
