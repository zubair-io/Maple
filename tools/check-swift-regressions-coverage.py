#!/usr/bin/env python3
"""Every MapleCore test class is either RUN by `swift-regressions` or EXCLUDED
on purpose — never silently absent (#3460).

`.github/workflows/apple.yml`'s `swift-regressions` job executes a fixed
allowlist of test classes, because the full package suite needs gitignored
RAW fixtures, a real Metal device, keychain and FileProvider hosts, or
minutes of render time the runner does not have. That allowlist used to be
the only record of what runs, so a class that nobody added (e.g.
`EditorStateTests`) sat red on `main` for weeks while the "MapleCore
execution gate" stayed green.

This check makes the exclusion explicit. Two committed lists:

  .github/swift-regressions/run.txt       classes the job executes
  .github/swift-regressions/excluded.txt  classes it does not, each with a
                                          reason tag and a short note

Every `XCTestCase` subclass under `Tests/MapleCoreTests` that declares at
least one `func test…` must appear in exactly one of them, and every listed
name must exist. A new test class therefore has to be placed consciously —
run it, or say why not — and a deleted or renamed class has to be removed
from the list it was on.

Exit 0 when consistent; prints every violation and exits 1 otherwise.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TESTS = ROOT / "src/apple/Packages/MapleCore/Tests/MapleCoreTests"
RUN_LIST = ROOT / ".github/swift-regressions/run.txt"
EXCLUDED_LIST = ROOT / ".github/swift-regressions/excluded.txt"
REASON_TAGS = {"fixture", "gpu", "host", "slow", "untriaged"}

CLASS_DECL = re.compile(r"^\s*(?:@\w+\s+)*(?:public\s+|internal\s+)?(?:final\s+)?class\s+(\w+)\s*:\s*(\w+)", re.M)
TEST_FUNC = re.compile(r"^\s*func\s+test\w*\s*\(", re.M)


def test_classes() -> set[str]:
    """XCTestCase subclasses (transitively) that declare a test method."""
    bases: dict[str, str] = {}
    has_tests: set[str] = set()
    for path in sorted(TESTS.rglob("*.swift")):
        source = path.read_text(encoding="utf-8")
        decls = list(CLASS_DECL.finditer(source))
        for index, decl in enumerate(decls):
            name, base = decl.group(1), decl.group(2)
            bases[name] = base
            end = decls[index + 1].start() if index + 1 < len(decls) else len(source)
            if TEST_FUNC.search(source, decl.end(), end):
                has_tests.add(name)

    def is_xctest(name: str, seen: frozenset[str] = frozenset()) -> bool:
        base = bases.get(name)
        if base is None or name in seen:
            return False
        return base == "XCTestCase" or is_xctest(base, seen | {name})

    return {name for name in has_tests if is_xctest(name)}


def read_list(path: Path, with_reason: bool) -> dict[str, str]:
    entries: dict[str, str] = {}
    for line_number, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        parts = line.split(None, 2)
        name = parts[0]
        if name in entries:
            sys.exit(f"{path}:{line_number}: `{name}` listed twice")
        if with_reason:
            tag = parts[1] if len(parts) > 1 else ""
            if tag not in REASON_TAGS:
                sys.exit(
                    f"{path}:{line_number}: `{name}` needs a reason tag "
                    f"({', '.join(sorted(REASON_TAGS))}) — got `{tag}`"
                )
            entries[name] = tag
        elif len(parts) > 1:
            sys.exit(f"{path}:{line_number}: run list entries are a bare class name")
        else:
            entries[name] = ""
    return entries


def main() -> int:
    classes = test_classes()
    run = read_list(RUN_LIST, with_reason=False)
    excluded = read_list(EXCLUDED_LIST, with_reason=True)
    problems: list[str] = []
    for name in sorted(classes - run.keys() - excluded.keys()):
        problems.append(f"`{name}` is in neither list — add it to run.txt, or to excluded.txt with a reason")
    for name in sorted(run.keys() & excluded.keys()):
        problems.append(f"`{name}` is in both lists")
    for name in sorted((run.keys() | excluded.keys()) - classes):
        problems.append(f"`{name}` is listed but no such test class exists (renamed or deleted?)")
    if problems:
        print("swift-regressions coverage: FAIL", file=sys.stderr)
        for problem in problems:
            print(f"  - {problem}", file=sys.stderr)
        return 1
    tags = {tag: sum(1 for t in excluded.values() if t == tag) for tag in sorted(REASON_TAGS)}
    print(
        f"swift-regressions coverage: OK — {len(classes)} test classes, "
        f"{len(run)} run, {len(excluded)} excluded ({', '.join(f'{k}={v}' for k, v in tags.items())})"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
