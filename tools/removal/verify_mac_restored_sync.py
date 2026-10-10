"""#3940: require observed real companion syncs at each confirmed-save boundary.

Consumes the selected LocalRemovalRestoredPublicationTests child's stderr with
mac_directory_sync_audit.c interposed. Markers delimit actual operations; earlier
fixture-write syncs cannot count as a receipt for a later Keep/redo/reuse.
This proves local syscall ordering, not physical power-loss or remote durability.
"""

import argparse
import hashlib
import json
import re
from pathlib import Path

TEST = "testRestoredKeepRedoAndReusedPublicationSynchronizeReferencedFiles"


def verify(path):
    data = path.read_bytes()
    text = data.decode()
    if (
        f"{TEST}]' passed" not in text
        or not re.search(r"Executed 1 test, with 0 failures", text)
        or " skipped " in text
    ):
        raise ValueError("Actual selected XCTest must complete without failure or skip")
    markers = re.findall(r"^MAPLE_RESTORED_(BEGIN|END) (\w+)$", text, re.MULTILINE)
    if markers != [
        (edge, action)
        for action in ["Keep", "Undo", "Redo", "Reuse"]
        for edge in ["BEGIN", "END"]
    ]:
        raise ValueError(
            "Expected complete ordered Keep/Undo/Redo/Reuse operation markers"
        )
    all_receipts = re.findall(
        r"^MAPLE_(FILE|DIRECTORY)_SYNC (-?\d+) (.+)$", text, re.MULTILINE
    )
    roots = {
        Path(*Path(p).parts[: i + 1])
        for _, _, p in all_receipts
        for i, part in enumerate(Path(p).parts)
        if part.startswith("removal-restored-publication-")
    }
    if len(roots) != 1:
        raise ValueError("Expected real syncs for one owned restored-publication root")
    root = next(iter(roots))
    carrier = root / ".maple/inpaint"
    restore_sections = [
        text.split("MAPLE_RESTORED_BEGIN Keep\n")[0],
        text.split("MAPLE_RESTORED_END Undo\n")[1].split("MAPLE_RESTORED_BEGIN Redo\n")[
            0
        ],
    ]
    for section in restore_sections:
        if any(
            Path(p).parent == carrier
            for p in re.findall(r"^MAPLE_FILE_SYNC -?\d+ (.+)$", section, re.MULTILINE)
        ):
            raise ValueError(
                "Restored fixture must not sync its companion bytes before the operation"
            )
    operations = {}
    for action in ["Keep", "Undo", "Redo", "Reuse"]:
        section = text.split(f"MAPLE_RESTORED_BEGIN {action}\n")[1].split(
            f"MAPLE_RESTORED_END {action}\n"
        )[0]
        receipts = [
            (kind, int(result), Path(p))
            for kind, result, p in re.findall(
                r"^MAPLE_(FILE|DIRECTORY)_SYNC (-?\d+) (.+)$", section, re.MULTILINE
            )
            if Path(p).is_relative_to(root)
        ]
        if any(result != 0 for _, result, _ in receipts):
            raise ValueError(f"{action}: failed real sync cannot confirm publication")
        events = [(kind, p) for kind, _, p in receipts]
        if action != "Undo":
            asset_events = events[:2]
            if (
                len(asset_events) != 2
                or {p.suffix for _, p in asset_events} != {".mask", ".f16"}
                or any(
                    kind != "FILE"
                    or p.parent != carrier
                    or not re.fullmatch(r"[0-9a-f]{64}", p.stem)
                    for kind, p in asset_events
                )
            ):
                raise ValueError(
                    f"{action}: missing referenced immutable file syncs before visibility"
                )
            if events[2:5] != [
                ("DIRECTORY", p) for p in [carrier, carrier.parent, root]
            ]:
                raise ValueError(
                    f"{action}: missing ordered carrier syncs after companions"
                )
            remainder = events[5:]
        else:
            remainder = events
        if action == "Reuse":
            if remainder:
                raise ValueError("Reuse cannot publish the accepted sidecar")
        else:
            required = [("FILE", root / ".source.xmp.tmp"), ("DIRECTORY", root)]
            # Foundation may sync its own atomic-write staging inode before
            # the explicit durable sidecar inode. It is not an asset receipt.
            staging = remainder[:-2]
            if remainder[-2:] != required or any(
                kind != "FILE"
                or p.parent != root
                or not p.name.startswith(".source.xmp.tmp.sb-")
                for kind, p in staging
            ):
                raise ValueError(
                    f"{action}: sidecar must sync after all referenced assets and carriers"
                )
        operations[action] = [(kind, str(p)) for kind, p in events]
    keep_assets = {
        p
        for kind, p in operations["Keep"]
        if kind == "FILE" and Path(p).parent == carrier
    }
    for action in ["Redo", "Reuse"]:
        assets = {
            p
            for kind, p in operations[action]
            if kind == "FILE" and Path(p).parent == carrier
        }
        if assets != keep_assets:
            raise ValueError(
                "Keep/Redo/Reuse must synchronize the identical referenced asset set"
            )
    return {
        "traceSHA256": hashlib.sha256(data).hexdigest(),
        "test": TEST,
        "operations": operations,
        "confirmedAssetOrdering": True,
        "releaseQualified": False,
        "scope": "Actual Darwin file/directory fsync calls; no physical power-loss, iOS or SMB claim",
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("trace", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    if args.output.exists():
        raise ValueError("Choose a fresh audit output")
    report = verify(args.trace)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
