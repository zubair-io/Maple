"""#3940: verify real Darwin access-loss/recovery XCTest and syscall evidence.

Rejects skipped/incomplete tests and receipts preceding the actual replacement.
Does not qualify process-death recovery, physical power-loss, NAS or live UI.
"""

import argparse
import hashlib
import json
import re
from pathlib import Path

POSITIVE = "testKeepUndoRedoRecoverAfterRealPostRenamePermissionLoss"
TESTS = {
    "testChangedOriginalRefusesReconciliationOfAlreadyPublishedRemoval": 1,
    POSITIVE: 3,
    "testSameRemovalStackCannotAuthorizeAChangedExternalSidecarAfterPartialSave": 1,
}


def verify(path):
    data = path.read_bytes()
    text = data.decode()
    if (
        not re.search(r"Executed 3 tests, with 0 failures \(0 unexpected\)", text)
        or " skipped " in text
        or " failed " in text
    ):
        raise ValueError(
            "Three actual XCTest cases must complete without failure or skip"
        )
    sections = re.findall(
        r"Test Case '-\[MapleCoreTests.LocalRemovalRecoveryProbeTests (\w+)\]' started\.\n"
        r"(.*?)Test Case '-\[MapleCoreTests.LocalRemovalRecoveryProbeTests \1\]' passed",
        text,
        re.DOTALL,
    )
    if len(sections) != 3 or {name for name, _ in sections} != set(TESTS):
        raise ValueError("Missing complete named XCTest cases")
    roots = set()
    operations = []
    for name, section in sections:
        revocations = list(
            re.finditer(
                r"^MAPLE_REAL_ACCESS_REVOCATION (\d+) (\d+) (.+)$",
                section,
                re.MULTILINE,
            )
        )
        if len(revocations) != TESTS[name]:
            raise ValueError("Missing actual post-replacement access revocations")
        section_roots = set()
        for index, event in enumerate(revocations):
            old, new, directory = event.groups()
            root = Path(directory).resolve()
            if old == new or int(old) == 0 or int(new) == 0:
                raise ValueError("Revocation must follow a changed real sidecar inode")
            if not re.fullmatch(r"removal-keep-recovery-[0-9A-F-]{36}", root.name):
                raise ValueError("Only owned unique recovery directories qualify")
            section_roots.add(root)
            end = (
                revocations[index + 1].start()
                if index + 1 < len(revocations)
                else len(section)
            )
            following = section[event.end() : end]
            receipts = [
                (kind, int(result), Path(p).resolve())
                for kind, result, p in re.findall(
                    r"^MAPLE_(FILE|DIRECTORY)_SYNC (-?\d+) (.+)$",
                    following,
                    re.MULTILINE,
                )
                if Path(p).resolve().is_relative_to(root)
            ]
            if name == POSITIVE:
                if any(result != 0 for _, result, _ in receipts):
                    raise ValueError("Failed real sync cannot confirm recovery")
                paths = [(kind, p) for kind, _, p in receipts]
                pair = [("FILE", root / "photo.xmp"), ("DIRECTORY", root)]
                if not any(paths[i : i + 2] == pair for i in range(len(paths) - 1)):
                    raise ValueError(
                        "Missing existing-XMP and parent sync after access loss"
                    )
                operations.append(
                    {"action": ["Keep", "Undo", "Redo"][index], "root": str(root)}
                )
            elif any(
                kind == "FILE" and p == root / "photo.xmp" for kind, _, p in receipts
            ):
                raise ValueError(
                    "Refused external change must not confirm the checkpoint"
                )
        if len(section_roots) != 1 or roots & section_roots:
            raise ValueError("Each test must use its own distinct root")
        roots.update(section_roots)
    return {
        "traceSHA256": hashlib.sha256(data).hexdigest(),
        "tests": TESTS,
        "actualAccessRevocations": 5,
        "distinctOwnedRoots": len(roots),
        "reconfirmedOperations": operations,
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
