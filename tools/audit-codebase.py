#!/usr/bin/env python3
"""Reproduce the source inventory for the KTLO audit (#3640).

Reads committed blobs, not working files. Counts physical lines, including
comments/blanks. Test and generated classifications are path heuristics, not
coverage measurements. Third-party trees are counted separately and not read.
"""

import argparse
import collections
import csv
import io
import json
import re
import subprocess
from pathlib import Path, PurePosixPath

EXTENSIONS = {
    ".rs",
    ".swift",
    ".ts",
    ".tsx",
    ".js",
    ".mjs",
    ".mts",
    ".cs",
    ".xaml",
    ".html",
    ".scss",
    ".css",
    ".py",
    ".sh",
    ".ps1",
    ".wgsl",
    ".metal",
    ".h",
}
THIRD_PARTY = ("src/raw-pipeline/vendor/", "src/raw-pipeline/third_party/")
TEST = re.compile(r"(?i)(/tests?/|tests?\.|\.spec\.|_tests?\.|/e2e/|\.stories\.)")


def git(*args):
    return subprocess.check_output(["git", *args])


def area(path):
    parts = path.split("/")
    return "/".join(parts[:2]) if parts[0] == "src" else parts[0]


def module(path):
    parts = path.split("/")
    if path.startswith("src/web/projects/"):
        if path.startswith("src/web/projects/maple-common/src/lib/"):
            return "/".join(parts[:7]) if len(parts) > 7 else "/".join(parts[:6])
        return "/".join(parts[:4])
    if path.startswith("src/apple/Packages/"):
        return "/".join(parts[:4])
    if path.startswith("src/api/src/"):
        return "/".join(parts[:4]) if len(parts) > 4 else "src/api/src"
    if path.startswith("src/windows/Maple.WinUI/"):
        return "/".join(parts[:4]) if len(parts) > 4 else "src/windows/Maple.WinUI"
    if path.startswith("src/"):
        return "/".join(parts[:3]) if len(parts) > 3 else "/".join(parts[:2])
    return parts[0]


def classification(path):
    if (
        any(x in path for x in ("/generated/", "/Generated/", "/dist/", "/Frameworks/"))
        or ".generated." in path
    ):
        return "generated-or-distributed"
    if TEST.search(path):
        return "test-or-story"
    if any(
        x in path for x in ("/scripts/", "/examples/", "/benches/")
    ) or path.startswith("tools/"):
        return "tool-or-example"
    return "implementation"


def write_csv(path, rows, fields):
    with path.open("w", newline="") as output:
        writer = csv.DictWriter(output, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ref", default="HEAD")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    commit = git("rev-parse", args.ref).decode().strip()
    tracked = (
        git("ls-tree", "-r", "--name-only", "-z", commit).decode().split("\0")[:-1]
    )
    third_party = [p for p in tracked if p.startswith(THIRD_PARTY)]
    paths = [
        p
        for p in tracked
        if not p.startswith(THIRD_PARTY) and PurePosixPath(p).suffix in EXTENSIONS
    ]
    request = "".join(f"{commit}:{p}\n" for p in paths).encode()
    blobs = subprocess.run(
        ["git", "cat-file", "--batch"], input=request, capture_output=True, check=True
    )
    stream = io.BytesIO(blobs.stdout)
    rows = []
    for path in paths:
        header = stream.readline().decode().split()
        if len(header) != 3 or header[1] != "blob":
            raise ValueError(f"Cannot read {path}: {header}")
        content = stream.read(int(header[2]))
        if stream.read(1) != b"\n":
            raise ValueError(f"Invalid blob separator for {path}")
        rows.append(
            {
                "path": path,
                "area": area(path),
                "module": module(path),
                "kind": classification(path),
                "extension": PurePosixPath(path).suffix,
                "lines": len(content.splitlines()),
            }
        )
    grouped = collections.defaultdict(lambda: collections.Counter())
    for row in rows:
        counts = grouped[row["module"]]
        counts["files"] += 1
        counts["lines"] += row["lines"]
        counts[row["kind"]] += 1
    args.out.mkdir(parents=True, exist_ok=True)
    write_csv(args.out / "source-inventory.csv", rows, list(rows[0]))
    module_rows = [
        {"module": name, **counts} for name, counts in sorted(grouped.items())
    ]
    write_csv(
        args.out / "module-inventory.csv",
        module_rows,
        [
            "module",
            "files",
            "lines",
            "implementation",
            "test-or-story",
            "tool-or-example",
            "generated-or-distributed",
        ],
    )
    areas = {}
    for name in sorted({r["area"] for r in rows}):
        subset = [r for r in rows if r["area"] == name]
        authored = [r for r in subset if r["kind"] != "generated-or-distributed"]
        areas[name] = {
            "source_files": len(subset),
            "authored_files": len(authored),
            "authored_lines": sum(r["lines"] for r in authored),
            "test_or_story_files": sum(r["kind"] == "test-or-story" for r in subset),
        }
    summary = {
        "commit": commit,
        "tracked_files": len(tracked),
        "third_party_files_excluded": len(third_party),
        "source_extensions": sorted(EXTENSIONS),
        "areas": areas,
        "limitations": "Physical lines; path-based classifications; inline tests remain in implementation files; not test coverage or a defect count.",
    }
    (args.out / "inventory-summary.json").write_text(
        json.dumps(summary, indent=2) + "\n"
    )
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
