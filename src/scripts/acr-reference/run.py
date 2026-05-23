"""Orchestrator — write XMP sidecars and manifest.json for a reference-renderer batch run.

Reads a list of RAWs, copies the canonical XMPs from ``test_0000/xmp/`` into
each RAW's ``<references>/<raw_stem>/xmp/`` directory, and emits a manifest.json
enumerating every (RAW × case × tier) → PNG triple for ``acr_batch.jsx`` to
consume. The manifest uses Mac-host paths so Photoshop can open them directly
from the sandbox-mounted workspace.

Typical use::

    cd src/scripts/acr-reference
    python3 run.py \\
      --raws ../../../test-fixtures/raws/test_0004.fff \\
             ../../../test-fixtures/raws/test_0005.RAF \\
             ... \\
      --out  ../../../test-fixtures/references/

Or with a glob::

    python3 run.py --raws ../../../test-fixtures/raws/test_*.* \\
                   --out  ../../../test-fixtures/references/

Special modes:
    --cases-filter <name> ...   Only write XMPs / manifest entries for these cases
    --cleanup-only              Remove <raw_basename>.xmp leftovers next to each RAW
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from matrix import CASES
from write_xmp import copy_canonical_xmps

# The Cowork sandbox mounts the host workspace under /sessions/.../mnt/_Maple/
# (or whatever the selected folder's basename is). Photoshop runs on the host
# Mac and needs literal host paths. This mapping is applied to every path
# written into manifest.json so the .jsx sees paths Photoshop can resolve.
#
# Override with --mac-root if the host layout differs.
DEFAULT_SANDBOX_PREFIX = "/sessions/"
DEFAULT_MAC_ROOT = "/Users/riabuz/Projects/_Maple"


def detect_mac_path(sandbox_path: Path, mac_root: str) -> str:
    """Translate a sandbox path to the Mac-host equivalent.

    The sandbox mount looks like ``/sessions/<session-id>/mnt/_Maple/...`` and
    maps to ``/Users/riabuz/Projects/_Maple/...`` on the host. If the input
    path is already absolute and doesn't start with ``/sessions/``, it's passed
    through unchanged (assumes the caller already gave a host path).
    """
    s = str(sandbox_path.resolve())
    if not s.startswith(DEFAULT_SANDBOX_PREFIX):
        return s

    # /sessions/<id>/mnt/<folder-name>/rest/of/path
    parts = s.split("/")
    # ['', 'sessions', '<id>', 'mnt', '<folder-name>', 'rest', ...]
    try:
        rest = "/".join(parts[5:])
    except IndexError:
        return s
    return f"{mac_root.rstrip('/')}/{rest}"


def canonical_xmp_dir(out_root: Path) -> Path:
    """The canonical XMP directory used as the source of truth for every case."""
    return out_root / "test_0000" / "xmp"


def build_manifest_entry(
    raw_host_path: str,
    raw_stem: str,
    case_name: str,
    xmp_host_path: str,
    out_root_host: str,
    tiers: tuple[str, ...],
) -> dict:
    """Build one ``cases[]`` entry for manifest.json."""
    outputs = []
    for tier in tiers:
        outputs.append({
            "resolution": tier,
            "long_edge": 4000 if tier == "down" else 0,
            "png": f"{out_root_host}/{raw_stem}/{tier}/{case_name}.png",
        })
    return {
        "raw": raw_host_path,
        "xmp": xmp_host_path,
        "name": f"{raw_stem}/{case_name}",
        "outputs": outputs,
    }


def cleanup_sidecars(raws: list[Path]) -> list[Path]:
    """Remove ``<raw_basename>.xmp`` left by ``acr_batch.jsx`` next to each RAW.

    Each ``app.open()`` causes the reference renderer to re-read the sidecar it left next to
    the RAW for previous case; we clean these after the batch finishes.
    """
    removed: list[Path] = []
    for raw in raws:
        sidecar = raw.with_suffix(".xmp")
        if sidecar.is_file():
            sidecar.unlink()
            removed.append(sidecar)
    return removed


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--raws", nargs="+", type=Path, required=True,
                    help="RAW files to generate references for")
    ap.add_argument("--out", type=Path, required=True,
                    help="References root directory (typically test-fixtures/references/)")
    ap.add_argument("--cases-filter", nargs="*", default=None,
                    help="If set, only emit these case names")
    ap.add_argument("--mac-root", default=DEFAULT_MAC_ROOT,
                    help=f"Mac-host root replacing the sandbox mount (default: {DEFAULT_MAC_ROOT})")
    ap.add_argument("--cleanup-only", action="store_true",
                    help="Only remove <raw>.xmp leftovers from --raws; don't regenerate anything")
    ap.add_argument("--canonical-xmp-dir", type=Path, default=None,
                    help="Source directory for canonical XMPs (default: <out>/test_0000/xmp/)")

    args = ap.parse_args(argv)

    out_root: Path = args.out.resolve()
    if not out_root.is_dir():
        print(f"ERROR: --out is not a directory: {out_root}", file=sys.stderr)
        return 2

    raws: list[Path] = [r.resolve() for r in args.raws]
    missing = [r for r in raws if not r.is_file()]
    if missing:
        for m in missing:
            print(f"ERROR: RAW not found: {m}", file=sys.stderr)
        return 2

    if args.cleanup_only:
        removed = cleanup_sidecars(raws)
        print(f"Removed {len(removed)} <raw>.xmp sidecars next to RAWs.")
        return 0

    canonical_dir = (args.canonical_xmp_dir or canonical_xmp_dir(out_root)).resolve()
    if not canonical_dir.is_dir():
        print(f"ERROR: canonical XMP dir not found: {canonical_dir}", file=sys.stderr)
        print("       Expected 43 canonical XMPs here (one per case in matrix.py).", file=sys.stderr)
        return 2

    # Which cases are in scope for this run?
    if args.cases_filter:
        requested = set(args.cases_filter)
        cases_in_scope = [c for c in CASES if c.name in requested]
        unknown = requested - {c.name for c in CASES}
        if unknown:
            print(f"ERROR: unknown case names: {sorted(unknown)}", file=sys.stderr)
            return 2
    else:
        cases_in_scope = list(CASES)

    # Copy canonical XMPs into each raw's xmp/ dir. Emit manifest entries.
    out_root_host = detect_mac_path(out_root, args.mac_root)
    manifest_cases: list[dict] = []
    total_xmps = 0
    total_outputs = 0

    for raw in raws:
        raw_stem = raw.stem  # "test_0004"
        raw_host = detect_mac_path(raw, args.mac_root)
        raw_ref_dir = out_root / raw_stem
        xmp_dir = raw_ref_dir / "xmp"

        # Skip canonical when a filter excludes it (e.g. won't overwrite canonical when out=test_0000).
        # But typically test_0000 is the source, not a target; protect against accidental self-copy.
        if xmp_dir.resolve() == canonical_dir.resolve():
            print(f"  [skip] {raw_stem}: xmp/ IS the canonical dir; not copying onto itself")
        else:
            # Limit the copy to filtered cases if --cases-filter is set.
            # Easiest: always copy everything (idempotent), then the manifest controls render scope.
            if args.cases_filter:
                xmp_dir.mkdir(parents=True, exist_ok=True)
                for c in cases_in_scope:
                    src = canonical_dir / f"{c.name}.xmp"
                    if not src.is_file():
                        print(f"ERROR: missing canonical XMP: {src}", file=sys.stderr)
                        return 2
                    (xmp_dir / f"{c.name}.xmp").write_bytes(src.read_bytes())
                total_xmps += len(cases_in_scope)
            else:
                written = copy_canonical_xmps(canonical_dir, xmp_dir)
                total_xmps += len(written)

        # Pre-create output dirs so Photoshop doesn't fail on saveAs.
        (raw_ref_dir / "down").mkdir(parents=True, exist_ok=True)
        (raw_ref_dir / "full").mkdir(parents=True, exist_ok=True)

        # Emit manifest entries.
        for c in cases_in_scope:
            xmp_path = xmp_dir / f"{c.name}.xmp"
            xmp_host = detect_mac_path(xmp_path, args.mac_root)
            entry = build_manifest_entry(
                raw_host_path=raw_host,
                raw_stem=raw_stem,
                case_name=c.name,
                xmp_host_path=xmp_host,
                out_root_host=out_root_host,
                tiers=c.tiers,
            )
            manifest_cases.append(entry)
            total_outputs += len(c.tiers)

    manifest = {"cases": manifest_cases}
    manifest_path = out_root / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")

    print("── run.py summary ─────────────────────────")
    print(f"  RAWs:             {len(raws)}")
    print(f"  Cases per RAW:    {len(cases_in_scope)}")
    print(f"  XMPs copied:      {total_xmps}")
    print(f"  Output PNGs:      {total_outputs}  (manifest.json entries: {len(manifest_cases)})")
    print(f"  manifest.json →   {manifest_path}")
    print(f"  mac_root:         {args.mac_root}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
