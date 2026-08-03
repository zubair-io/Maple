#!/usr/bin/env python3
"""Audit a photo library for folders whose only child is a single folder.

Folders sometimes get created in anticipation of siblings that never arrive,
leaving a pass-through layer that adds depth without organising anything:
``2019/Iceland/Iceland/*.cr2`` rather than ``2019/Iceland/*.cr2``.

A folder is a *pass-through* when it holds exactly one visible subfolder and no
visible files. Consecutive pass-throughs form a *chain*, which this reports as a
unit -- ``A/B/C`` where A holds only B and B holds only C is one finding with a
collapse depth of 2, not two overlapping findings.

Hidden entries do not count as children. A ``.maple/`` cache or a ``.DS_Store``
sitting beside the single subfolder does not make that folder meaningful, and
both are regenerable. Their presence is reported because they travel along with
any later cleanup.

This is read-only. It never moves or deletes anything.

    tools/audit-single-child-folders.py
    tools/audit-single-child-folders.py --no-include-duplicates
"""

from __future__ import annotations

import argparse
import os
import sys

DEFAULT_ROOT = "/Volumes/Photos-1"


def classify(directory: str) -> tuple[list[str], list[str], list[str], list[str]]:
    """Return ``(visible_dirs, visible_files, hidden_dirs, hidden_files)``.

    Names only, not paths. Unreadable directories yield four empty lists so a
    permissions problem on one folder cannot abort the whole audit.
    """
    visible_dirs: list[str] = []
    visible_files: list[str] = []
    hidden_dirs: list[str] = []
    hidden_files: list[str] = []
    try:
        with os.scandir(directory) as entries:
            for entry in entries:
                hidden = entry.name.startswith(".")
                try:
                    is_dir = entry.is_dir(follow_symlinks=False)
                except OSError:
                    continue
                bucket = (
                    (hidden_dirs if hidden else visible_dirs)
                    if is_dir
                    else (hidden_files if hidden else visible_files)
                )
                bucket.append(entry.name)
    except OSError:
        return [], [], [], []
    return visible_dirs, visible_files, hidden_dirs, hidden_files


def is_passthrough(directory: str) -> bool:
    """True when ``directory`` holds exactly one visible subfolder and no files."""
    visible_dirs, visible_files, _, _ = classify(directory)
    return len(visible_dirs) == 1 and not visible_files


def walk_dirs(root: str, include_duplicates: bool):
    """Yield every visible directory under ``root``, skipping hidden trees."""
    for dirpath, dirnames, _ in os.walk(root, followlinks=False):
        # Prune hidden trees in place: .maple, .coral, .trash-empty-dirs-*, ...
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        if not include_duplicates and os.path.relpath(dirpath, root).split(os.sep)[0] == "_duplicates":
            dirnames[:] = []
            continue
        for name in dirnames:
            yield os.path.join(dirpath, name)


def build_chains(root: str, include_duplicates: bool) -> list[dict]:
    """Find maximal pass-through chains.

    A chain starts at a pass-through whose parent is not itself a pass-through,
    so each chain is reported once from its topmost link rather than once per
    link. It extends downward while each successive child is also a
    pass-through, and ends at the first folder that is not -- the *terminal*,
    which holds the content the chain is burying.
    """
    passthrough = {d for d in walk_dirs(root, include_duplicates) if is_passthrough(d)}
    chains: list[dict] = []

    for start in sorted(passthrough):
        if os.path.dirname(start) in passthrough:
            continue  # not the top of its chain

        links = [start]
        current = start
        while True:
            visible_dirs, _, _, _ = classify(current)
            child = os.path.join(current, visible_dirs[0])
            if child in passthrough:
                links.append(child)
                current = child
                continue
            terminal = child
            break

        t_dirs, t_files, t_hidden_dirs, t_hidden_files = classify(terminal)
        # Hidden clutter anywhere along the chain travels with a cleanup.
        hidden_on_links = sum(len(classify(l)[2]) + len(classify(l)[3]) for l in links)

        # Collapsing promotes the terminal into the chain's parent. If a
        # different entry of that name already lives there, the collapse needs a
        # rename decision rather than a plain move. A destination that is itself
        # one of the chain's links is not a collision -- the collapse vacates it,
        # which is exactly the ``Iceland/Iceland`` same-name case.
        destination = os.path.join(os.path.dirname(start), os.path.basename(terminal))
        collides = (
            destination != terminal
            and destination not in links
            and os.path.exists(destination)
        )
        # Names on the discarded links are lost unless folded into the terminal.
        drops_names = os.path.basename(terminal) != os.path.basename(start)

        chains.append(
            {
                "root": start,
                "links": links,
                "depth": len(links),
                "terminal": terminal,
                "terminal_dirs": len(t_dirs),
                "terminal_files": len(t_files),
                "terminal_hidden": len(t_hidden_dirs) + len(t_hidden_files),
                "hidden_on_links": hidden_on_links,
                "collides": collides,
                "drops_names": drops_names,
                "duplicates": os.path.relpath(start, root).split(os.sep)[0] == "_duplicates",
            }
        )
    return chains


def collapse_preview(root: str, chain: dict) -> tuple[str, str]:
    """Render one chain as ``(annotated_current, flattened)``.

    The current path marks the redundant segments with ``[...]`` so they are
    distinguishable from surrounding context. Printing the bare path invites
    reading an unmarked parent as part of the finding when it is only the
    location of it.
    """
    parent = os.path.dirname(os.path.relpath(chain["root"], root))
    link_names = [os.path.basename(link) for link in chain["links"]]
    terminal_name = os.path.basename(chain["terminal"])

    segments = ([parent] if parent else []) + [f"[{n}]" for n in link_names] + [terminal_name]
    flattened = os.path.join(parent, terminal_name) if parent else terminal_name
    return "/".join(segments), flattened


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Audit for folders whose only child is a single folder (read-only).",
    )
    parser.add_argument("--root", default=DEFAULT_ROOT, help=f"library root (default: {DEFAULT_ROOT})")
    parser.add_argument(
        "--no-include-duplicates",
        dest="include_duplicates",
        action="store_false",
        help="skip the _duplicates/ tree",
    )
    parser.add_argument("--min-depth", type=int, default=1, help="only report chains at least this long")
    args = parser.parse_args()

    root = os.path.realpath(args.root)
    if not os.path.isdir(root):
        print(f"error: {args.root} is not a directory (is the volume mounted?)", file=sys.stderr)
        return 1

    print(f"Scanning {root} ...")
    chains = [c for c in build_chains(root, args.include_duplicates) if c["depth"] >= args.min_depth]
    if not chains:
        print("\nNo single-child folder chains found.")
        return 0

    main_tree = [c for c in chains if not c["duplicates"]]
    dupes = [c for c in chains if c["duplicates"]]

    by_depth: dict[int, int] = {}
    for c in chains:
        by_depth[c["depth"]] = by_depth.get(c["depth"], 0) + 1

    print(f"\n{len(chains)} chains  ({len(main_tree)} main tree, {len(dupes)} _duplicates/)")
    print("Segments in [brackets] are the redundant layers; everything else is context.")
    print("\nchain length   count   meaning")
    print("-" * 58)
    for depth in sorted(by_depth):
        noun = "layer" if depth == 1 else "layers"
        print(f"{depth:>10}   {by_depth[depth]:>7}   {depth} redundant {noun} to remove")

    for label, group in (("main tree", main_tree), ("_duplicates/", dupes)):
        if not group:
            continue
        print(f"\n{'=' * 70}\n{label}: {len(group)} chains\n{'=' * 70}")
        for c in sorted(group, key=lambda c: (-c["depth"], c["root"])):
            note = []
            if c["terminal_files"]:
                note.append(f"{c['terminal_files']} files")
            if c["terminal_dirs"]:
                note.append(f"{c['terminal_dirs']} subdirs")
            if not note:
                note.append("empty terminal")
            clutter = c["hidden_on_links"] + c["terminal_hidden"]
            if clutter:
                note.append(f"{clutter} hidden")
            flags = []
            if c["collides"]:
                flags.append("!! NAME COLLISION at destination")
            if c["drops_names"]:
                flags.append("renames")
            suffix = f"   <{' , '.join(flags)}>" if flags else ""
            current, flattened = collapse_preview(root, c)
            print(f"\n  [depth {c['depth']}] {' , '.join(note)}{suffix}")
            print(f"    {current}")
            print(f"    -> {flattened}")

    total_layers = sum(c["depth"] for c in chains)
    collisions = [c for c in chains if c["collides"]]
    renames = [c for c in chains if c["drops_names"] and not c["collides"]]
    print(f"\n{'=' * 70}")
    print(f"{total_layers} redundant folder layers across {len(chains)} chains.")
    if collisions:
        print(f"{len(collisions)} would collide with an existing name and need a rename decision.")
    if renames:
        print(f"{len(renames)} would discard the outer folder's name (inner name wins).")
    print("Read-only audit -- nothing was changed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
