#!/usr/bin/env python3
"""Local-only regression gate for a committed perf row (#3421).

    python3 tools/check-perf-ratchet.py <fresh-row.json> <committed-row.json>

Compares a freshly recorded row (e.g. `test-fixtures/perf/apple-macos/run.json`
from a `MAPLE_PERF_RECORD=...` run) against the committed row for the same
device — matched on (fixture, profile, viewportWidth, viewportHeight), same as
`PerfRecordWriter`'s own de-dup key — and fails (exit 1) if the fresh run
regresses any gated metric by more than that metric's jitter margin. Exits 0
(pass) when every gated metric is within margin, and exits 2 on a usage or
lookup error (no matching row, malformed JSON) so a broken invocation is never
mistaken for a passing measurement.

Never wired into cloud CI. Apple's perf tests are not cloud-gated at all
(docs/apple.md § "Build and test" — the cloud job compiles MapleCore only, no
test target runs there), so there is no stable CI machine for an absolute-time
gate to run on; this script is a local, pre-PR sanity check, the same role
`FILTER=... src/scripts/test_color_pipeline.sh` plays for the colour budgets.
It is a companion to, and does not replace, `SliderTickPerfTests`' in-run
ON/OFF ratio gate (#2113) — that gate is machine-independent by construction
(both arms of the ratio run on the same machine in the same process) and stays
exactly as it is.

## Where the margins below come from

Chosen from two back-to-back `EditorWorkflowPerfTests` runs recorded for this
ticket on one Mac (M5 Max) while three sibling agent sessions were compiling
Rust and a fourth was compiling MapleCore concurrently on the same machine —
see the PR that added `test-fixtures/perf/apple-macos/*.json` for both raw
runs. Between those two runs:

  - exposure tick p95:    +18.8 %   (18.90 ms -> 22.46 ms)
  - contrast tick p95:   +205.9 %   (10.37 ms -> 31.74 ms)
  - cold open, cached:    +63.5 %   ( 967 ms  -> 1581 ms)
  - cold open, uncached: +216.7 %   (2992 ms  -> 9475 ms)
  - export:               +15.9 %   (64.6 s   -> 74.8 s)

That is contention noise, not this script's noise floor — a quiet machine
should show far less run-to-run spread. Lacking a quiet-machine pair to
calibrate against, the margins below split the difference: wide enough that
ordinary background load (another build, a Spotlight index) doesn't misfire
the gate, tighter than the worst contended swing above so an actual
regression can still be caught. TICK_MARGIN sits above the steadier tick
metric (exposure) and well below the noisiest one (contrast) observed here;
OPEN_MARGIN and EXPORT_MARGIN follow the same logic for their own fields.
**Re-derive these from a quiet-machine pair of runs when one is available,
and tighten — this is a starting point, not a calibrated ceiling.**
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

# Relative margins as fractions (0.5 == fresh may be up to 1.5x committed).
TICK_MARGIN = 0.75
OPEN_CACHED_MARGIN = 0.75
OPEN_UNCACHED_MARGIN = 1.0
EXPORT_MARGIN = 0.5

MATCH_KEYS = ("fixture", "profile", "viewportWidth", "viewportHeight")

# (row key, human label, margin)
SCALAR_METRICS: list[tuple[str, str, float]] = [
    ("coldOpenCachedMs", "cold open (cached)", OPEN_CACHED_MARGIN),
    ("coldOpenUncachedMs", "cold open (uncached)", OPEN_UNCACHED_MARGIN),
    ("exportMs", "export", EXPORT_MARGIN),
]
# (tick group key, sub-field, human label, margin)
TICK_METRICS: list[tuple[str, str, str, float]] = [
    ("tickExposure", "p95Ms", "exposure tick p95", TICK_MARGIN),
    ("tickExposure", "maxMs", "exposure tick max", TICK_MARGIN),
    ("tickContrast", "p95Ms", "contrast tick p95", TICK_MARGIN),
    ("tickContrast", "maxMs", "contrast tick max", TICK_MARGIN),
]


def load_rows(path: Path) -> list[dict[str, Any]]:
    data = json.loads(path.read_text())
    return data if isinstance(data, list) else [data]


def match_key(row: dict[str, Any]) -> tuple[Any, ...]:
    return tuple(row.get(k) for k in MATCH_KEYS)


def find_committed(fresh: dict[str, Any], committed_rows: list[dict[str, Any]]) -> dict[str, Any] | None:
    target = match_key(fresh)
    for row in committed_rows:
        if match_key(row) == target:
            return row
    return None


def check_scalar(
    fresh: dict[str, Any], committed: dict[str, Any], key: str, label: str, margin: float
) -> str | None:
    fresh_value, committed_value = fresh.get(key), committed.get(key)
    if fresh_value is None or committed_value is None:
        return None
    ceiling = committed_value * (1.0 + margin)
    if fresh_value > ceiling:
        pct = ((fresh_value / committed_value) - 1.0) * 100 if committed_value else float("inf")
        return (
            f"{label}: fresh {fresh_value:.2f} ms > ceiling {ceiling:.2f} ms "
            f"(committed {committed_value:.2f} ms + {margin:.0%} margin) — {pct:+.1f}%"
        )
    return None


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(f"usage: {argv[0]} <fresh-row.json> <committed-row.json>", file=sys.stderr)
        return 2

    fresh_path, committed_path = Path(argv[1]), Path(argv[2])
    try:
        fresh_rows = load_rows(fresh_path)
        committed_rows = load_rows(committed_path)
    except (OSError, json.JSONDecodeError) as error:
        print(f"error reading input: {error}", file=sys.stderr)
        return 2

    if not fresh_rows:
        print(f"error: {fresh_path} contains no rows", file=sys.stderr)
        return 2

    failures: list[str] = []
    checked = 0
    for fresh in fresh_rows:
        committed = find_committed(fresh, committed_rows)
        if committed is None:
            key = dict(zip(MATCH_KEYS, match_key(fresh)))
            print(f"no committed row matches {key} in {committed_path} — skipping", file=sys.stderr)
            continue
        checked += 1
        for key, label, margin in SCALAR_METRICS:
            failure = check_scalar(fresh, committed, key, label, margin)
            if failure:
                failures.append(failure)
        for group, field, label, margin in TICK_METRICS:
            fresh_group, committed_group = fresh.get(group) or {}, committed.get(group) or {}
            failure = check_scalar(
                {field: fresh_group.get(field)},
                {field: committed_group.get(field)},
                field,
                label,
                margin,
            )
            if failure:
                failures.append(failure)

    if checked == 0:
        print("error: no fresh row matched any committed row", file=sys.stderr)
        return 2

    if failures:
        print(f"PERF RATCHET FAILED — {len(failures)} metric(s) regressed past their jitter margin:")
        for failure in failures:
            print(f"  - {failure}")
        return 1

    print(f"PERF RATCHET PASSED — {checked} row(s) checked against {committed_path}, all within margin.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
