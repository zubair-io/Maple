#!/usr/bin/env python3
"""Enforce the one-way ratchet on test-fixtures/budgets.json (#1934).

CLAUDE.md and test_color_pipeline.sh both state the color-parity budgets are a
one-way ratchet: "Budgets are a one-way ratchet — they can only go down."
Nothing enforced it in CI — cross.yml's allowlist-shrinks-only job guards a
DIFFERENT file (tools/budget-allowlist.txt, the LOC allowlist), and
tools/budget_init.py is a seeding helper, not a gate. This script is the gate.

Contract, per (fixture, case, metric) cell that exists on the BASE branch:
  * a raised ceiling (head > base for mean / p95 / max / bias) FAILS — those
    four metrics are all ceilings, so "lower is stricter"; a budget may only
    tighten (go down) or hold.
  * a removed cell (present on base, absent on head — a dropped fixture, case,
    or metric) FAILS — dropping a budget silently drops its gate.
New cells (a fixture / case / metric absent on base, present on head) are
ALLOWED: adding coverage is the ratchet turning the right way.

Lowering a ceiling is expected to happen in the SAME commit that delivers the
pipeline improvement (that is the whole point of the ratchet), so a lowered
value passes.

## RE-BASELINE markers (#2335)

The ratchet has no audited path for a LEGITIMATE re-baseline — a re-capture
against a changed default pipeline that ratchets most cells down but a few
up (#814: 218 down, 41 up). Blocking those 41 with no override just invites
disabling the whole required check, which leaves no record at all. Instead,
a raise passes when it is covered by a `RE-BASELINE:` marker line:

  RE-BASELINE: <fixture>/<case>.<metric>: <justification>

One line per raised cell, found in the PR body and/or the PR's head commit
message (either location is fine — the commit message is what survives
"Rebase and merge" into `main`'s history, since the PR body itself does
not). A marker with no justification text is not a marker — the raise it
would have covered still fails. Every accepted marker is echoed to stdout
so the audit trail lands in the CI log regardless of which location matched.
This does not touch removed cells: a marker only ever permits a RAISE, never
a removal — dropping a budget silently drops its gate either way.

Modes:
  --self-test              run the built-in unit tests (no fixtures needed),
                           exit 0 on pass. This is what CI runs unconditionally
                           to gate the checker's own logic.
  --base FILE --head FILE  diff two budget JSON files; exit 1 on any
                           unaudited violation. --marker-file FILE optionally
                           supplies RE-BASELINE marker text to permit
                           specific raises.

The CI job (cross.yml) resolves the PR merge base, `git show`s that revision's
test-fixtures/budgets.json into a temp file, concatenates the PR body and the
head commit message into a marker file, and runs `--base <that> --head
test-fixtures/budgets.json --marker-file <that>`. When budgets.json did not
exist at the merge base (a brand-new file) there is nothing to ratchet
against and the job passes.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from typing import Any

# The four gated metrics in budgets.json. All are ceilings (lower = stricter),
# so the ratchet is "head <= base" for every one of them.
METRICS = ("mean", "p95", "max", "bias")

# Float tolerance so a re-serialization round-trip (e.g. 6.45 -> 6.4500000001)
# can't be misread as a raise. Budgets are stored to 2-4 decimals; 1e-9 is far
# below any real ratchet step.
EPS = 1e-9


# A single gated cell: (fixture, case, metric).
Cell = tuple[str, str, str]

# `RE-BASELINE: <fixture>/<case>.<metric>: <justification>`. Fixture/case
# names are `[A-Za-z0-9_.-]+` (matches every existing budgets.json key);
# justification is free text, required non-empty.
_MARKER_RE = re.compile(
    r"^RE-BASELINE:\s*([A-Za-z0-9_.\-]+)/([A-Za-z0-9_.\-]+)\.("
    + "|".join(METRICS)
    + r")\s*:\s*(.+?)\s*$"
)


def parse_re_baseline_markers(text: str) -> dict[Cell, str]:
    """Parse `RE-BASELINE:` lines out of a PR body / commit message.

    Returns `{(fixture, case, metric): justification}`. A line whose
    justification is empty after stripping is NOT a marker — the cell it
    would have covered is left ungated, so an unattributed raise still
    fails the same as if no marker existed.
    """
    markers: dict[Cell, str] = {}
    for line in text.splitlines():
        m = _MARKER_RE.match(line.strip())
        if not m:
            continue
        fixture, case, metric, justification = m.groups()
        if justification:
            markers[(fixture, case, metric)] = justification
    return markers


def _fixtures(budgets: dict[str, Any]) -> dict[str, Any]:
    """The {fixture: {case: {metric: value}}} map, tolerating a missing key."""
    fx = budgets.get("fixtures", {})
    return fx if isinstance(fx, dict) else {}


def find_violations(
    base: dict[str, Any],
    head: dict[str, Any],
    markers: dict[Cell, str] | None = None,
) -> tuple[list[str], list[str]]:
    """Return `(violations, audited)` — human-readable strings, both empty on
    a clean pass.

    Only cells that EXIST on base are checked: a raise (head > base) or a
    removal (missing on head) is normally a violation. Anything new on head
    is fine. A raise whose cell has a `markers` entry is instead reported in
    `audited`, not `violations` — a marker only ever excuses a RAISE, never
    a removal.
    """
    markers = markers or {}
    violations: list[str] = []
    audited: list[str] = []
    base_fx = _fixtures(base)
    head_fx = _fixtures(head)

    for fixture, base_cases in base_fx.items():
        head_cases = head_fx.get(fixture)
        if head_cases is None:
            violations.append(f"{fixture}: fixture removed (was present at base)")
            continue
        for case, base_metrics in base_cases.items():
            head_metrics = head_cases.get(case)
            if head_metrics is None:
                violations.append(
                    f"{fixture}/{case}: case removed (was present at base)"
                )
                continue
            for metric in METRICS:
                if metric not in base_metrics:
                    continue
                base_val = base_metrics[metric]
                if metric not in head_metrics:
                    violations.append(
                        f"{fixture}/{case}.{metric}: metric removed "
                        f"(was {base_val} at base)"
                    )
                    continue
                head_val = head_metrics[metric]
                if head_val > base_val + EPS:
                    justification = markers.get((fixture, case, metric))
                    if justification is None:
                        violations.append(
                            f"{fixture}/{case}.{metric}: raised {base_val} -> "
                            f"{head_val} (budgets only ratchet DOWN; no "
                            "RE-BASELINE marker for this cell)"
                        )
                    else:
                        audited.append(
                            f"{fixture}/{case}.{metric}: raised {base_val} -> "
                            f"{head_val} — RE-BASELINE: {justification}"
                        )
    return violations, audited


def _load(path: str) -> dict[str, Any]:
    with open(path) as f:
        return json.load(f)


def run_diff(base_path: str, head_path: str, marker_path: str | None = None) -> int:
    base = _load(base_path)
    head = _load(head_path)
    markers: dict[Cell, str] = {}
    if marker_path:
        with open(marker_path, encoding="utf-8", errors="replace") as f:
            markers = parse_re_baseline_markers(f.read())

    violations, audited = find_violations(base, head, markers)

    if audited:
        print(
            f"check_budget_ratchet: {len(audited)} audited RE-BASELINE "
            "raise(s) (permitted, logged for the record):"
        )
        for a in audited:
            print(f"  - {a}")

    if violations:
        print(
            "check_budget_ratchet: budgets.json violated the one-way ratchet "
            f"({len(violations)} issue(s)):",
            file=sys.stderr,
        )
        for v in violations:
            print(f"  - {v}", file=sys.stderr)
        print(
            "\nBudgets may only go DOWN (or hold) and may not be removed. "
            "Lower a ceiling only in the same commit that delivers the "
            "improvement; add new cells freely. To land a deliberate raise, "
            "add a `RE-BASELINE: <fixture>/<case>.<metric>: <justification>` "
            "line to the PR body or the commit message for each raised cell.",
            file=sys.stderr,
        )
        return 1
    print("check_budget_ratchet: OK — no unaudited budget was raised or removed.")
    return 0


def _self_test() -> int:
    def cell(mean: float, p95: float, mx: float, bias: float) -> dict[str, float]:
        return {"mean": mean, "p95": p95, "max": mx, "bias": bias}

    base = {
        "version": 1,
        "fixtures": {
            "test_0000": {
                "baseline": cell(6.45, 11.27, 39.8, 0.0195),
                "baseline_auto": cell(3.36, 6.99, 36.55, 0.0132),
            }
        },
    }

    def check(
        name: str,
        head: dict[str, Any],
        expect_violation: bool,
        markers: dict[Cell, str] | None = None,
        expect_audited: int = 0,
    ) -> bool:
        v, a = find_violations(base, head, markers)
        ok = (bool(v) == expect_violation) and (len(a) == expect_audited)
        status = "ok" if ok else "FAIL"
        print(
            f"  [{status}] {name}: {len(v)} violation(s), {len(a)} audited {v if v else ''}"
        )
        return ok

    import copy

    ok = True

    # 1. Identical head — no violation.
    ok &= check("unchanged", copy.deepcopy(base), expect_violation=False)

    # 2. A lowered ceiling — no violation (ratchet turning the right way).
    lowered = copy.deepcopy(base)
    lowered["fixtures"]["test_0000"]["baseline"]["mean"] = 5.90
    ok &= check("lowered mean", lowered, expect_violation=False)

    # 3. A raised ceiling — violation.
    raised = copy.deepcopy(base)
    raised["fixtures"]["test_0000"]["baseline"]["max"] = 45.0
    ok &= check("raised max", raised, expect_violation=True)

    # 4. A raised bias — violation.
    raised_bias = copy.deepcopy(base)
    raised_bias["fixtures"]["test_0000"]["baseline"]["bias"] = 0.03
    ok &= check("raised bias", raised_bias, expect_violation=True)

    # 5. A removed case — violation.
    removed_case = copy.deepcopy(base)
    del removed_case["fixtures"]["test_0000"]["baseline_auto"]
    ok &= check("removed case", removed_case, expect_violation=True)

    # 6. A removed fixture — violation.
    removed_fixture = copy.deepcopy(base)
    del removed_fixture["fixtures"]["test_0000"]
    ok &= check("removed fixture", removed_fixture, expect_violation=True)

    # 7. A removed metric — violation.
    removed_metric = copy.deepcopy(base)
    del removed_metric["fixtures"]["test_0000"]["baseline"]["p95"]
    ok &= check("removed metric", removed_metric, expect_violation=True)

    # 8. A brand-new case added — no violation (adding coverage).
    added_case = copy.deepcopy(base)
    added_case["fixtures"]["test_0000"]["sharpen_amount_max"] = cell(9, 15, 60, 0.05)
    ok &= check("added case", added_case, expect_violation=False)

    # 9. A brand-new fixture added — no violation.
    added_fixture = copy.deepcopy(base)
    added_fixture["fixtures"]["test_0099"] = {"baseline": cell(7, 12, 40, 0.02)}
    ok &= check("added fixture", added_fixture, expect_violation=False)

    # 10. Float-noise round-trip — no violation (within EPS).
    noisy = copy.deepcopy(base)
    noisy["fixtures"]["test_0000"]["baseline"]["mean"] = 6.45 + 1e-12
    ok &= check("float-noise hold", noisy, expect_violation=False)

    # ---- RE-BASELINE marker cases (#2335) ----

    # 11. A raise covered by a matching marker — no violation, one audited.
    ok &= check(
        "raised max with matching RE-BASELINE marker",
        raised,
        expect_violation=False,
        markers={("test_0000", "baseline", "max"): "sensor cal retune, see #814"},
        expect_audited=1,
    )

    # 12. A raise with a marker for a DIFFERENT cell — still a violation;
    # a marker only covers the exact cell it names.
    ok &= check(
        "raised max with marker for a different cell",
        raised,
        expect_violation=True,
        markers={("test_0000", "baseline", "bias"): "unrelated cell"},
        expect_audited=0,
    )

    # 13. A raise with a marker but an EMPTY justification — the parser
    # drops it (see `parse_re_baseline_markers`), so this simulates the
    # already-dropped state directly: still a violation.
    ok &= check(
        "raised max with an empty-justification marker (parser would drop it)",
        raised,
        expect_violation=True,
        markers={},
        expect_audited=0,
    )

    # 14. A marker present but nothing was actually raised — harmless no-op.
    ok &= check(
        "unraised marker is a no-op",
        copy.deepcopy(base),
        expect_violation=False,
        markers={("test_0000", "baseline", "max"): "nothing to excuse here"},
        expect_audited=0,
    )

    # ---- parse_re_baseline_markers ----

    def check_parse(name: str, text: str, expected: dict[Cell, str]) -> bool:
        got = parse_re_baseline_markers(text)
        ok = got == expected
        status = "ok" if ok else "FAIL"
        print(f"  [{status}] parse: {name}: {got}")
        return ok

    ok &= check_parse(
        "single well-formed line",
        "RE-BASELINE: test_0013/baseline.max: view-transform retune, see #814",
        {("test_0013", "baseline", "max"): "view-transform retune, see #814"},
    )
    ok &= check_parse(
        "multiple lines amid unrelated PR-body prose",
        "## What\nRe-baselines a few cells.\n"
        "RE-BASELINE: test_0013/baseline.max: retune (#814)\n"
        "RE-BASELINE: test_0018/baseline_auto.p95: same retune (#814)\n"
        "\nCloses #814\n",
        {
            ("test_0013", "baseline", "max"): "retune (#814)",
            ("test_0018", "baseline_auto", "p95"): "same retune (#814)",
        },
    )
    ok &= check_parse(
        "empty justification is dropped",
        "RE-BASELINE: test_0013/baseline.max:   ",
        {},
    )
    ok &= check_parse(
        "unknown metric does not match",
        "RE-BASELINE: test_0013/baseline.notametric: nope",
        {},
    )
    ok &= check_parse(
        "leading whitespace on the marker line still matches",
        "   RE-BASELINE: test_0013/baseline.mean: indented in a list",
        {("test_0013", "baseline", "mean"): "indented in a list"},
    )

    print("check_budget_ratchet self-test:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true", help="run built-in tests")
    parser.add_argument("--base", help="path to the base-branch budgets.json")
    parser.add_argument("--head", help="path to the head budgets.json")
    parser.add_argument(
        "--marker-file",
        help="path to text (PR body + commit message) to scan for "
        "RE-BASELINE markers; omit to require every raise to fail",
    )
    args = parser.parse_args()

    if args.self_test:
        return _self_test()
    if args.base and args.head:
        return run_diff(args.base, args.head, args.marker_file)
    parser.error("pass --self-test, or both --base and --head")
    return 2  # unreachable (argparse.error exits), keeps type-checkers happy


if __name__ == "__main__":
    sys.exit(main())
