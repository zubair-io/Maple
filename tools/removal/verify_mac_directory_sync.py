"""#3940: require real successful bottom-up companion directory sync receipts.

Reads stderr from the actual LocalRemovalDirectoryPublicationTests XCTest
child with mac_directory_sync_audit.c loaded. It fails on missing interposition,
failed/skipped tests, missing ancestor syncs or incorrect publication order.
This syscall observation is not a power-loss or remote-filesystem simulation.
"""

import argparse
import hashlib
import json
import re
from pathlib import Path

TEST = "testFirstSaveAndDeepTransferRetainAllImmutableAssetsAndSidecarOrder"


def verify(path):
    data = path.read_bytes()
    text = data.decode()
    if (
        f"{TEST}]' passed" not in text
        or not re.search(r"Executed 1 test, with 0 failures", text)
        or " skipped " in text
    ):
        raise ValueError("Actual selected XCTest must complete without failure or skip")
    receipts = [
        (int(result), Path(directory))
        for result, directory in re.findall(
            r"^MAPLE_DIRECTORY_SYNC (-?\d+) (.+)$", text, re.MULTILINE
        )
        if "removal-directory-publication-" in directory
    ]
    roots = {
        Path(*directory.parts[: index + 1])
        for _, directory in receipts
        for index, part in enumerate(directory.parts)
        if part.startswith("removal-directory-publication-")
    }
    if len(roots) != 1 or any(result != 0 for result, _ in receipts):
        raise ValueError(
            "Expected successful real directory syncs for one owned test root"
        )
    root = next(iter(roots))
    paths = [directory for _, directory in receipts]
    source = root / ".maple/inpaint"
    target = root / "new/nested/photos/.maple/inpaint"
    starts = [i for i, directory in enumerate(paths) if directory in [source, target]]
    expected = [
        [source, source.parent, root],
        [
            target,
            target.parent,
            target.parent.parent,
            root / "new/nested",
            root / "new",
            root,
        ],
        [target, target.parent, target.parent.parent],
    ]
    if len(starts) != 3:
        raise ValueError(
            "Expected first publication, deep transfer and existing-tree retry"
        )
    for start, required in zip(starts, expected, strict=True):
        if paths[start : start + len(required)] != required:
            raise ValueError(
                f"Missing bottom-up carrier/ancestor syncs at publication {start}"
            )
    # Confirmed sidecar directory sync follows every referenced-asset sync.
    if paths[starts[0] + len(expected[0]) : starts[1]] != [root] or paths[
        starts[1] + len(expected[1]) : starts[2]
    ] != [target.parent.parent]:
        raise ValueError(
            "Sidecar must be durably published after its complete carrier tree"
        )
    return {
        "traceSHA256": hashlib.sha256(data).hexdigest(),
        "test": TEST,
        "root": str(root),
        "successfulDirectorySyncs": [str(p) for p in paths],
        "requiredPublicationSequences": [[str(p) for p in group] for group in expected],
        "sidecarFollowsCompanions": True,
        "releaseQualified": False,
        "scope": "Actual Darwin fsync calls and real local fixtures; not physical power-loss, iOS or SMB qualification",
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
