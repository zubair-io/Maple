"""Require every direct Apple SF Symbol call to have an explicit exception."""

import json
import re
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INVENTORY = ROOT / "docs/design/maple-ui/apple-icon-inventory.json"
SCOPES = ["src/apple/Maple", "src/apple/Packages/MapleUI/Sources"]


def main():
    inventory = json.loads(INVENTORY.read_text())
    records = inventory["migration"]["nativeExceptions"]
    allowed = Counter(
        (row["file"], row["source"]) for row in records if row["reason"].strip()
    )
    actual = Counter()
    for scope in SCOPES:
        for path in sorted((ROOT / scope).rglob("*.swift")):
            for number, line in enumerate(path.read_text().splitlines(), 1):
                if line.lstrip().startswith("//"):
                    continue
                if not re.search(r"\bsystem(?:Name|Image):", line):
                    continue
                key = (str(path.relative_to(ROOT)), line.strip())
                actual[key] += 1
                if actual[key] > allowed[key]:
                    print(f"Untracked native icon: {key[0]}:{number}: {key[1]}")
    for path, source in sorted(allowed - actual):
        print(f"Stale native icon exception: {path}: {source}")
    if actual != allowed:
        raise SystemExit(1)
    print(f"Apple icons: {actual.total()} explicit native exceptions verified")


if __name__ == "__main__":
    main()
