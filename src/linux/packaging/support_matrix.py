#!/usr/bin/env python3
"""Validate the Linux support matrix and keep the README table in sync (#5449)."""

import argparse
import json
import re
from pathlib import Path

LINUX = Path(__file__).resolve().parents[1]
MATRIX = LINUX / "packaging/support-matrix.json"
README = LINUX / "README.md"
BEGIN = "<!-- support-matrix:start -->"
END = "<!-- support-matrix:end -->"


def validate(matrix: dict) -> dict:
    if matrix.get("schema_version") != 1:
        raise ValueError("Unsupported support matrix schema")
    keys = set()
    for row in matrix["rows"]:
        for field, table in (
            ("distribution", "distributions"),
            ("package", "packages"),
            ("session", "sessions"),
            ("status", "statuses"),
        ):
            if row[field] not in matrix[table]:
                raise ValueError(f"Unknown {field} {row[field]!r}")
        key = (row["distribution"], row["package"], row["session"], row["gpu"])
        if key in keys:
            raise ValueError(f"Duplicate row {key}")
        keys.add(key)
        if row["status"] == "qualified" and not row.get("evidence", "").startswith(
            "https://"
        ):
            raise ValueError(f"Qualified row {key} needs an evidence link")
        if row["status"] == "ci-smoke" and not (
            "smoke" in matrix["sessions"][row["session"]]
            and "container" in matrix["distributions"][row["distribution"]]
        ):
            raise ValueError(f"CI cannot run {key}; it cannot be marked ci-smoke")
    return matrix


def load(path: Path = MATRIX) -> dict:
    return validate(json.loads(path.read_text()))


def table(matrix: dict) -> str:
    """Prettier's aligned Markdown table, so formatting cannot cause drift."""
    header = ["Distribution", "Package", "Session", "GPU", "Status"]
    cells = [
        [
            matrix["distributions"][row["distribution"]]["name"],
            matrix["packages"][row["package"]],
            matrix["sessions"][row["session"]]["name"],
            row["gpu"],
            f"[{row['status']}]({row['evidence']})"
            if "evidence" in row
            else row["status"],
        ]
        for row in matrix["rows"]
    ]
    widths = [max(map(len, column)) for column in zip(header, *cells)]
    lines = [
        "| " + " | ".join(cell.ljust(width) for cell, width in zip(line, widths)) + " |"
        for line in [header, ["-" * width for width in widths], *cells]
    ]
    legend = [f"- **{name}**: {text}" for name, text in matrix["statuses"].items()]
    return "\n".join([*lines, "", *legend])


def render(readme: str, matrix: dict) -> str:
    pattern = re.escape(BEGIN) + r".*?" + re.escape(END)
    if len(re.findall(pattern, readme, flags=re.DOTALL)) != 1:
        raise ValueError("The README needs exactly one support-matrix block")
    return re.sub(
        pattern,
        lambda _: f"{BEGIN}\n\n{table(matrix)}\n\n{END}",
        readme,
        flags=re.DOTALL,
    )


def ci_smoke(matrix: dict) -> list[dict]:
    """One container job per distribution and package, running its sessions."""
    jobs: dict[tuple[str, str], list[str]] = {}
    for row in matrix["rows"]:
        if row["status"] == "ci-smoke":
            smoke = matrix["sessions"][row["session"]]["smoke"]
            jobs.setdefault((row["distribution"], row["package"]), []).append(smoke)
    return [
        {
            "container": matrix["distributions"][distribution]["container"],
            "package": package,
            "sessions": ",".join(sessions),
        }
        for (distribution, package), sessions in jobs.items()
    ]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--write", action="store_true", help="Rewrite the README")
    action.add_argument("--ci-matrix", action="store_true", help="Print CI jobs")
    args = parser.parse_args()
    matrix = load()
    if args.ci_matrix:
        print(json.dumps(ci_smoke(matrix), separators=(",", ":")))
        return
    readme = README.read_text()
    rendered = render(readme, matrix)
    if args.write:
        README.write_text(rendered)
    elif rendered != readme:
        raise SystemExit(
            "src/linux/README.md disagrees with support-matrix.json; "
            "run python3 src/linux/packaging/support_matrix.py --write"
        )
    print("README support table matches support-matrix.json")


if __name__ == "__main__":
    main()
