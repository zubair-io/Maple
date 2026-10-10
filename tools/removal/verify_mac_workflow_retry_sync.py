"""#3940: observe durable acknowledgement of an already-present removal restore.

Consumes actual RemovalWorkflowRetryTests stderr using mac_directory_sync_audit.c.
Each operation must sync the referenced companions/carriers, the existing XMP
inode and its parent. Earlier or temporary-file receipts cannot substitute.
No physical power-loss, live UI or remote-filesystem claim.
"""

import argparse
import hashlib
import json
import re
from pathlib import Path

TEST = "testAlreadyPublishedRemovalRestoreReconfirmsDurabilityWithoutDuplicatingHistory"


def verify(path):
    data = path.read_bytes()
    text = data.decode()
    if (
        f"{TEST}]' passed" not in text
        or not re.search(r"Executed 1 test, with 0 failures", text)
        or " skipped " in text
    ):
        raise ValueError("Actual selected XCTest must complete without failure or skip")
    actions = ["Restore", "RepeatedRestore"]
    markers = re.findall(
        r"^MAPLE_WORKFLOW_RETRY_(BEGIN|END) (\w+)$", text, re.MULTILINE
    )
    if markers != [(edge, action) for action in actions for edge in ["BEGIN", "END"]]:
        raise ValueError("Expected complete ordered restore/repeated-restore markers")
    roots = {
        Path(*Path(p).parts[: i + 1])
        for p in re.findall(
            r"^MAPLE_(?:FILE|DIRECTORY)_SYNC -?\d+ (.+)$", text, re.MULTILINE
        )
        for i, part in enumerate(Path(p).parts)
        if part.startswith("removal-workflow-retry-")
    }
    if len(roots) != 1:
        raise ValueError("Expected real syncs for one owned workflow retry root")
    root = next(iter(roots))
    carrier = root / ".maple/inpaint"
    operations = {}
    for action in actions:
        section = text.split(f"MAPLE_WORKFLOW_RETRY_BEGIN {action}\n")[1].split(
            f"MAPLE_WORKFLOW_RETRY_END {action}\n"
        )[0]
        events = [
            (kind, int(result), Path(p))
            for kind, result, p in re.findall(
                r"^MAPLE_(FILE|DIRECTORY)_SYNC (-?\d+) (.+)$", section, re.MULTILINE
            )
            if Path(p).is_relative_to(root)
        ]
        if any(result != 0 for _, result, _ in events):
            raise ValueError("Failed real sync cannot confirm the checkpoint")
        paths = [(kind, p) for kind, _, p in events]
        assets = paths[:2]
        if (
            len(assets) != 2
            or {p.suffix for _, p in assets} != {".mask", ".f16"}
            or any(
                kind != "FILE"
                or p.parent != carrier
                or not re.fullmatch(r"[0-9a-f]{64}", p.stem)
                for kind, p in assets
            )
        ):
            raise ValueError("Missing referenced companion syncs")
        if paths[2:5] != [("DIRECTORY", p) for p in [carrier, carrier.parent, root]]:
            raise ValueError("Missing ordered companion carrier syncs")
        if paths[5:] != [("FILE", root / "source.xmp"), ("DIRECTORY", root)]:
            raise ValueError("Missing existing sidecar sync after verified carriers")
        operations[action] = [(kind, str(p)) for kind, p in paths]
    if operations[actions[0]] != operations[actions[1]]:
        raise ValueError(
            "Repeated restore must reconfirm the identical checkpoint and assets"
        )
    return {
        "test": TEST,
        "traceSHA256": hashlib.sha256(data).hexdigest(),
        "operations": operations,
        "existingSidecarDurabilityReconfirmed": True,
        "releaseQualified": False,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("trace", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    if args.output.exists():
        raise ValueError("Choose a fresh output")
    report = verify(args.trace)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
