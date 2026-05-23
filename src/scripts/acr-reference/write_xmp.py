"""Copy the canonical reference XMP sidecars into a target case directory.

Rationale for *copying* rather than *generating*:

    The canonical XMP set under ``test-fixtures/references/test_0000/xmp/``
    already drives 176 committed PNGs. Re-emitting bytes from slider values
    risks a whitespace / attribute-order / encoding diff that would silently
    invalidate the existing references. Copying guarantees byte-identical
    XMPs across every RAW — the only ground-truth axis that should vary
    between RAWs is the pixels the reference renderer produces, not the sidecar it consumes.

If a case ever needs to be added or retuned, update the canonical XMPs
directly under ``test_0000/xmp/`` and re-run ``run.py`` to propagate.
"""
from __future__ import annotations

import shutil
from pathlib import Path

from matrix import CASES


def copy_canonical_xmps(canonical_dir: Path, target_dir: Path) -> list[Path]:
    """Copy every canonical XMP into ``target_dir``, overwriting on conflict.

    Parameters
    ----------
    canonical_dir
        Directory containing ``<case>.xmp`` for every case in :data:`matrix.CASES`.
        In practice this is ``test-fixtures/references/test_0000/xmp/``.
    target_dir
        Destination. Created if missing.

    Returns
    -------
    list[Path]
        The destination paths that were written, in :data:`matrix.CASES` order.

    Raises
    ------
    FileNotFoundError
        If any canonical XMP is missing.
    """
    target_dir.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    missing: list[str] = []

    for case in CASES:
        src = canonical_dir / f"{case.name}.xmp"
        if not src.is_file():
            missing.append(case.name)
            continue
        dst = target_dir / f"{case.name}.xmp"
        shutil.copyfile(src, dst)
        written.append(dst)

    if missing:
        raise FileNotFoundError(
            f"Canonical XMPs missing from {canonical_dir}: {', '.join(missing)}"
        )

    return written


if __name__ == "__main__":
    import argparse
    import sys

    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--canonical", type=Path, required=True,
                    help="Source directory containing the 43 canonical XMPs")
    ap.add_argument("--target", type=Path, required=True,
                    help="Destination directory for the copied XMPs")
    args = ap.parse_args()

    try:
        written = copy_canonical_xmps(args.canonical, args.target)
    except FileNotFoundError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)

    print(f"Wrote {len(written)} XMPs to {args.target}")
