"""Unique fixture/case identity accounting for the Maple color qualification harness (#4226).

Preserves all comparison executions across passes and resolutions while tracking unique
(fixture, case) identities so capability registry evidence reports unique executed,
failed, and skipped counts.
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Optional

STATUS_PASSED = "passed"
STATUS_BREACH = "breach"
STATUS_ERROR = "error"
STATUS_SKIPPED_NO_RAW = "skipped_no_raw"
STATUS_SKIPPED_NO_CANDIDATE = "skipped_no_candidate"
STATUS_SKIPPED_NO_REFERENCE = "skipped_no_reference"

EXEC_PASS_STATUSES = {STATUS_PASSED, "pass"}
EXEC_FAIL_STATUSES = {STATUS_BREACH, "failed", "budget_breach", STATUS_ERROR}
SKIPPED_STATUSES = {
    STATUS_SKIPPED_NO_RAW,
    STATUS_SKIPPED_NO_CANDIDATE,
    STATUS_SKIPPED_NO_REFERENCE,
}
ALL_VALID_STATUSES = EXEC_PASS_STATUSES | EXEC_FAIL_STATUSES | SKIPPED_STATUSES


@dataclass(frozen=True)
class CaseOutcome:
    fixture: str
    case: str
    status: str
    resolution: Optional[str] = None
    profile: Optional[str] = None
    breaches: tuple[str, ...] = ()
    error: Optional[str] = None
    mean: Optional[float] = None

    def is_executed(self) -> bool:
        return self.status in (EXEC_PASS_STATUSES | EXEC_FAIL_STATUSES)

    def is_failed(self) -> bool:
        return self.status in EXEC_FAIL_STATUSES

    def is_skipped(self) -> bool:
        return self.status in SKIPPED_STATUSES


@dataclass
class AccountingResult:
    comparisons_executed: int
    comparisons_failed: int
    comparisons_skipped: int
    comparisons_errors: int
    unique_executed: int
    unique_failed: int
    unique_skipped: int
    cases_by_identity: dict[tuple[str, str], list[CaseOutcome]]


def validate_case_outcome(data: Any) -> CaseOutcome:
    if not isinstance(data, dict):
        raise TypeError(f"Expected case record dict, got {type(data).__name__}")

    fixture = data.get("fixture")
    if not isinstance(fixture, str) or not fixture.strip():
        raise ValueError(f"Missing or invalid 'fixture' in record: {data}")
    fixture = fixture.strip()
    if "/" in fixture or "\\" in fixture or any(c.isspace() for c in fixture):
        raise ValueError(f"Inconsistent or malformed fixture name '{fixture}' in record")

    case = data.get("case") or data.get("case_label")
    if not isinstance(case, str) or not case.strip():
        raise ValueError(f"Missing or invalid 'case' in record: {data}")
    case = case.strip()
    if any(c.isspace() for c in case):
        raise ValueError(f"Inconsistent or malformed case name '{case}' in record")

    status = data.get("status")
    if not isinstance(status, str) or status not in ALL_VALID_STATUSES:
        raise ValueError(f"Missing or invalid 'status' '{status}' in record: {data}")

    if status in EXEC_PASS_STATUSES:
        norm_status = STATUS_PASSED
    elif status in {STATUS_BREACH, "failed", "budget_breach"}:
        norm_status = STATUS_BREACH
    elif status == STATUS_ERROR:
        norm_status = STATUS_ERROR
    else:
        norm_status = status

    resolution = data.get("resolution")
    if resolution is not None and not isinstance(resolution, str):
        raise ValueError(f"Invalid 'resolution' in record: {data}")

    profile = data.get("profile")
    if profile is not None and not isinstance(profile, str):
        raise ValueError(f"Invalid 'profile' in record: {data}")

    breaches = data.get("breaches") or ()
    if isinstance(breaches, str):
        breaches = (breaches,)
    elif isinstance(breaches, list):
        breaches = tuple(breaches)
    elif not isinstance(breaches, tuple):
        raise ValueError(f"Invalid 'breaches' sequence in record: {data}")

    error = data.get("error")
    if error is not None and not isinstance(error, str):
        error = str(error)

    mean = data.get("mean")
    if mean is not None and not isinstance(mean, (int, float)):
        raise ValueError(f"Invalid 'mean' in record: {data}")
    mean_val = float(mean) if mean is not None else None

    return CaseOutcome(
        fixture=fixture,
        case=case,
        status=norm_status,
        resolution=resolution,
        profile=profile,
        breaches=breaches,
        error=error,
        mean=mean_val,
    )


def load_qualification_records(source: str | Path | Iterable[str]) -> list[CaseOutcome]:
    lines: Iterable[str]
    if isinstance(source, (str, Path)):
        p = Path(source)
        if not p.is_file():
            raise FileNotFoundError(f"Qualification summary file not found: {source}")
        with open(p, "r", encoding="utf-8") as f:
            lines = f.readlines()
    else:
        lines = source

    outcomes: list[CaseOutcome] = []
    found_any_json = False

    for line_idx, line in enumerate(lines, start=1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError as err:
            raise ValueError(f"Malformed JSON on line {line_idx}: {err}") from err

        found_any_json = True
        if not isinstance(entry, dict):
            raise ValueError(f"Expected JSON object on line {line_idx}, got {type(entry).__name__}")

        if "cases" in entry and isinstance(entry["cases"], list):
            for c in entry["cases"]:
                outcomes.append(validate_case_outcome(c))
        elif "fixture" in entry:
            outcomes.append(validate_case_outcome(entry))
        elif "compared" in entry:
            # Legacy summary line without per-case records
            pass
        else:
            raise ValueError(f"Unrecognized record format on line {line_idx}: {line}")

    if not found_any_json:
        raise ValueError("Qualification summary source contained no JSON lines")
    if not outcomes:
        raise ValueError("No per-case qualification records found in summary source")

    return outcomes


def aggregate_qualification(records: Iterable[Any]) -> AccountingResult:
    outcomes: list[CaseOutcome] = []
    for r in records:
        if isinstance(r, CaseOutcome):
            outcomes.append(r)
        else:
            outcomes.append(validate_case_outcome(r))

    if not outcomes:
        raise ValueError("No qualification case records found to aggregate")

    comparisons_executed = 0
    comparisons_failed = 0
    comparisons_skipped = 0
    comparisons_errors = 0

    cases_by_identity: dict[tuple[str, str], list[CaseOutcome]] = {}

    for o in outcomes:
        if o.is_executed():
            comparisons_executed += 1
            if o.is_failed():
                comparisons_failed += 1
                if o.status == STATUS_ERROR:
                    comparisons_errors += 1
        elif o.is_skipped():
            comparisons_skipped += 1

        key = (o.fixture, o.case)
        if key not in cases_by_identity:
            cases_by_identity[key] = []
        cases_by_identity[key].append(o)

    unique_executed = 0
    unique_failed = 0
    unique_skipped = 0

    for (fixture, case), case_outcomes in cases_by_identity.items():
        executed_runs = [co for co in case_outcomes if co.is_executed()]
        if executed_runs:
            unique_executed += 1
            if any(co.is_failed() for co in executed_runs):
                unique_failed += 1
        else:
            unique_skipped += 1

    return AccountingResult(
        comparisons_executed=comparisons_executed,
        comparisons_failed=comparisons_failed,
        comparisons_skipped=comparisons_skipped,
        comparisons_errors=comparisons_errors,
        unique_executed=unique_executed,
        unique_failed=unique_failed,
        unique_skipped=unique_skipped,
        cases_by_identity=cases_by_identity,
    )


def format_comparison_totals(result: AccountingResult) -> str:
    return f"# comparisons: executed={result.comparisons_executed} failed={result.comparisons_failed}"


def format_qualification_evidence(result: AccountingResult) -> str:
    return (
        f"qualification: executed={result.unique_executed} "
        f"failed={result.unique_failed} skipped={result.unique_skipped}"
    )


def main(argv: Optional[list[str]] = None) -> int:
    if argv is None:
        argv = sys.argv[1:]

    if not argv:
        print("Usage: color_qualification_accounting.py <qualification_summary_jsonl>", file=sys.stderr)
        return 2

    summary_path = argv[0]
    try:
        outcomes = load_qualification_records(summary_path)
        result = aggregate_qualification(outcomes)
    except Exception as err:
        print(f"color_qualification_accounting: error: {err}", file=sys.stderr)
        return 1

    print(format_comparison_totals(result))
    print(format_qualification_evidence(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
