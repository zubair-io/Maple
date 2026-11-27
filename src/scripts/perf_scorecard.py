#!/usr/bin/env python3
"""Performance scorecard (#6147): runs each target's committed benchmark and judges the min and
median of its runs against the target's limit and this machine's budget.

  python3 src/scripts/perf_scorecard.py [--targets a,b] [--runs 5] [--raw-dir DIR] [--json OUT]
                                        [--work-dir DIR] [--machine-class NAME] [--regressions-only]
  python3 src/scripts/perf_scorecard.py --check-ratchet --base-ref origin/main

Exit 0: all selected targets measured and within limit and budget. 1: something is over. 2: not
over, but a target was not measured or the run failed. Limits and budgets: docs/performance.md.
"""

from __future__ import annotations

import argparse
import json
import platform
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Callable, NamedTuple

REPO_ROOT = Path(__file__).resolve().parents[2]
SCORECARD_BUDGETS = "test-fixtures/perf/scorecard-budgets.json"
LISTING_BUDGETS = "src/api/scripts/folder-listing-budget.json"
EXAMPLES = REPO_ROOT / "src/raw-pipeline/target/release/examples"
FFI_PERF = EXAMPLES / "ffi-perf"
PERF_AUDIT_DNG = EXAMPLES / "perf-audit-dng"
SYNTHETIC_PHOTO = (
    REPO_ROOT / "src/apple/Packages/MapleCore/Tests/MapleCoreTests/Fixtures/portrait-skin-test.png"
)
CAMERA_RAW = "test_0007.DNG"
MIN_RUNS = 5
LIMIT_MET = "limitMet"
LISTING_RUNS = 30
NO_RUNNER = "no committed runner, see #6146"
NO_RUNNER_REASONS = {
    "grid_scroll": "src/scripts/measure_grid_scroll.sh measures it on a Mac with an unlocked "
    "screen; the scorecard has no runner for it yet, see #6146",
}

TITLES = {
    "listing": "Folder listing, 2,000 items",
    "preview": "1280 px camera preview render",
    "export": "Default 24 MP export",
    "cold_launch": "Cold launch",
    "lan_thumbnails": "LAN thumbnails",
    "grid_scroll": "Grid scroll",
}
OK, OVER_LIMIT, OVER_BUDGET = "ok", "OVER limit", "OVER budget"
TARGET_NOT_MET = "target not met"
NO_LIMIT, NO_BUDGET = "no limit for this machine", "no budget for this machine"
NOT_MEASURED = "NOT MEASURED"
CEILING_KEYS = {
    SCORECARD_BUDGETS: {"limitMs", "limitFractionOfBaseline", "limitDroppedFrames", "baselineMs",
                        "budgetMs"},
    LISTING_BUDGETS: {"targetWarmMedianMs", "warmMedianMs", "revalidateMedianMs",
                      "limit500MedianMs"},
}
FFI_LINE = re.compile(r"^FFI (\S+)\s+min\s+([\d.]+) ms\s+median\s+([\d.]+) ms\s+digest\s+\w+$")
ARCHES = {"x86_64": "x64", "amd64": "x64", "aarch64": "arm64", "arm64": "arm64"}


class NotMeasured(Exception):
    pass


class Measurement(NamedTuple):
    min_ms: float
    median_ms: float
    detail: tuple[str, ...] = ()


class Env(NamedTuple):
    raw_dir: Path
    work_dir: Path
    runs: int
    raw_free: bool = False


class Row(NamedTuple):
    target: str
    measurement: Measurement | None
    limit_ms: float | None
    budget_ms: float | None
    limit_text: str
    verdict: str


def median(values: list[float]) -> float:
    return sorted(values)[len(values) // 2]


def machine_key(system: str, machine: str, cpu_model: str | None) -> str:
    named = (cpu_model or "").strip()
    cpu = "unknown CPU" if named.lower() in ("", "unknown") else named
    return f"{system}-{ARCHES.get(machine.lower(), machine.lower())} {cpu}"


def detect_cpu_model() -> str | None:
    try:
        return read_cpu_model()
    except OSError:
        return None


def read_cpu_model() -> str | None:
    if sys.platform == "darwin":
        probe = subprocess.run(["sysctl", "-n", "machdep.cpu.brand_string"],
                               capture_output=True, text=True)
        return probe.stdout.strip() if probe.returncode == 0 else None
    if sys.platform.startswith("linux"):
        lines = Path("/proc/cpuinfo").read_text().splitlines()
        return next((x.partition(":")[2] for x in lines if x.startswith("model name")), None)
    return None


def parse_ffi_line(output: str, label: str) -> Measurement:
    matches = (FFI_LINE.match(line.strip()) for line in output.splitlines())
    found = next((m for m in matches if m and m[1] == label), None)
    if found is None:
        raise NotMeasured(f"ffi-perf printed no `{label}` line")
    return Measurement(float(found[2]), float(found[3]))


def parse_listing(output: str) -> Measurement:
    lines = output.strip().splitlines()
    try:
        warm = json.loads(lines[-1])["warm"]
        measurement = Measurement(float(warm["wallMin"]), float(warm["wallMedian"]))
    except (IndexError, KeyError, TypeError, ValueError) as error:
        raise NotMeasured(f"the listing benchmark printed no warm timings ({error!r})") from error
    if warm.get("status") != 200:
        raise NotMeasured(f"the warm listing request answered {warm.get('status')}, not 200")
    return measurement


def judge(
    median_ms: float, limit_ms: float | None, budget_ms: float | None, enforce_limit: bool = True
) -> str:
    over_budget = budget_ms is not None and median_ms > budget_ms
    if limit_ms is not None and median_ms > limit_ms:
        if enforce_limit:
            return OVER_LIMIT
        return OVER_BUDGET if over_budget else TARGET_NOT_MET
    if over_budget:
        return OVER_BUDGET
    if limit_ms is None:
        return NO_LIMIT
    return OK if budget_ms is not None else NO_BUDGET


def exit_code(rows: list[Row], regressions_only: bool = False) -> int:
    if any(row.verdict in (OVER_LIMIT, OVER_BUDGET) for row in rows):
        return 1
    unjudgeable = any(row.verdict.startswith(NOT_MEASURED) for row in rows) or (
        regressions_only and any(row.verdict == NO_BUDGET for row in rows)
    )
    return 2 if unjudgeable else 0


def limits_for(
    target: str, budgets: dict, listing: dict, key: str
) -> tuple[float | None, float | None]:
    if target == "listing":
        machine = listing["machines"].get(key, {})
        return listing["targetWarmMedianMs"], machine.get("warmMedianMs")
    spec = budgets["targets"][target]
    machine = spec.get("machines", {}).get(key, {})
    fraction, baseline = spec.get("limitFractionOfBaseline"), machine.get("baselineMs")
    if fraction is None:
        return spec.get("limitMs"), machine.get("budgetMs")
    return (None if baseline is None else fraction * baseline), machine.get("budgetMs")


def enforces_limit(target: str, budgets: dict, regressions_only: bool) -> bool:
    return not regressions_only or budgets["targets"].get(target, {}).get("limitMet", False)


def limit_text(target: str, limit_ms: float | None, budgets: dict) -> str:
    dropped = budgets["targets"].get(target, {}).get("limitDroppedFrames")
    if dropped is not None:
        return f"{dropped} dropped frames"
    return "-" if limit_ms is None else f"{limit_ms:g} ms"


def flatten(node: object, keys: set[str], path: tuple[str, ...] = ()) -> dict[str, float]:
    if isinstance(node, dict):
        return {p: v for k, c in node.items() for p, v in flatten(c, keys, (*path, k)).items()}
    numeric = isinstance(node, (int, float)) and not isinstance(node, bool)
    return {"/".join(path): node} if numeric and path and path[-1] in keys else {}


def met_limits(node: object, path: tuple[str, ...] = ()) -> set[str]:
    if isinstance(node, dict):
        return {p for k, c in node.items() for p in met_limits(c, (*path, k))}
    return {"/".join(path)} if node is True and path and path[-1] == LIMIT_MET else set()


def ratchet_offenders(name: str, base: dict, now: dict, keys: set[str]) -> list[str]:
    before, after = flatten(base, keys), flatten(now, keys)
    removed = [f"{name}: {p} was {v} and is gone" for p, v in before.items() if p not in after]
    raised = [f"{name}: {p} raised {v} -> {after[p]}" for p, v in before.items()
              if p in after and after[p] > v]
    unmet = [f"{name}: {p} was true and is no longer" for p in sorted(met_limits(base))
             if p not in met_limits(now)]
    return removed + raised + unmet


def require(path: Path, hint: str) -> Path:
    if not path.is_file():
        raise NotMeasured(f"{path} is missing; {hint}")
    return path


def run_tool(command: list[str], cwd: Path, timeout_s: int) -> str:
    try:
        done = subprocess.run(command, cwd=cwd, capture_output=True, text=True, timeout=timeout_s)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise NotMeasured(f"{command[0]} could not run: {error}") from error
    if done.returncode != 0:
        tail = (done.stderr.strip().splitlines() or ["no stderr"])[-1]
        raise NotMeasured(f"{Path(command[0]).name} exited {done.returncode}: {tail}")
    return done.stdout


def synthetic_dng(work_dir: Path, width: int, height: int) -> Path:
    out = work_dir / f"synthetic-{width}x{height}.dng"
    if not out.is_file():
        tool = require(
            PERF_AUDIT_DNG,
            "build it: cargo build --release -p raw-core --features test-support "
            "--example perf-audit-dng (in src/raw-pipeline)",
        )
        partial = out.with_name(out.name + ".part")
        run_tool([str(tool), str(SYNTHETIC_PHOTO), str(width), str(height), str(partial)],
                 REPO_ROOT, 900)
        if not partial.is_file():
            raise NotMeasured(f"{tool.name} wrote no {partial.name}")
        partial.replace(out)
    return out


def ffi_case(raw: Path, runs: int, case: str) -> Measurement:
    tool = require(FFI_PERF, "build it: cargo build --release -p raw-ffi --example ffi-perf "
                   "(in src/raw-pipeline)")
    return parse_ffi_line(run_tool([str(tool), str(raw), str(runs), case], REPO_ROOT, 1800), case)


def measure_listing(env: Env) -> Measurement:
    if shutil.which("bun") is None:
        raise NotMeasured("bun is not installed")
    command = ["bun", "scripts/bench-folder-listing.ts", "--runs", str(LISTING_RUNS), "--json"]
    return parse_listing(run_tool(command, REPO_ROOT / "src/api", 1800))


def camera_raw(env: Env) -> Path | None:
    camera = env.raw_dir / CAMERA_RAW
    if env.raw_free:
        return None
    return require(camera, f"pass --raw-dir with {CAMERA_RAW}, or --machine-class on a runner "
                   "without RAW fixtures")


def measure_preview(env: Env) -> Measurement:
    camera = camera_raw(env)
    fallback = "develop_fallback_1280_jpeg"
    cases = [
        ("develop fallback, 24 MP", synthetic_dng(env.work_dir, 6000, 4000), fallback),
        ("develop fallback, 100 MP", synthetic_dng(env.work_dir, 12288, 8192), fallback),
    ]
    if camera is not None:
        cases.insert(0, (f"embedded preview of {CAMERA_RAW}", camera, "preview_embedded_1280_jpeg"))
    results = [(title, ffi_case(raw, env.runs, case)) for title, raw, case in cases]
    worst = max(results, key=lambda r: r[1].median_ms)[1]
    detail = tuple(f"{t}: min {m.min_ms:.1f} ms, median {m.median_ms:.1f} ms" for t, m in results)
    return Measurement(worst.min_ms, worst.median_ms, detail)


def measure_export(env: Env) -> Measurement:
    camera = camera_raw(env)
    raw = camera if camera is not None else synthetic_dng(env.work_dir, 6000, 4000)
    times = [ffi_case(raw, 1, "export_full_jpeg_default").median_ms for _ in range(env.runs)]
    source = CAMERA_RAW if camera else "the synthetic 24 MP DNG"
    note = f"{env.runs} processes of one run on {source}"
    return Measurement(min(times), median(times), (note,))


MEASURERS: dict[str, Callable[[Env], Measurement]] = {
    "listing": measure_listing,
    "preview": measure_preview,
    "export": measure_export,
}


def build_row(
    target: str,
    env: Env,
    budgets: dict,
    listing: dict,
    key: str,
    measurers: dict[str, Callable[[Env], Measurement]] = MEASURERS,
    regressions_only: bool = False,
) -> Row:
    limit_ms, budget_ms = limits_for(target, budgets, listing, key)
    text = limit_text(target, limit_ms, budgets)
    try:
        if target not in measurers:
            raise NotMeasured(NO_RUNNER_REASONS.get(target, NO_RUNNER))
        measurement = measurers[target](env)
    except NotMeasured as reason:
        return Row(target, None, limit_ms, budget_ms, text, f"{NOT_MEASURED} ({reason})")
    enforced = enforces_limit(target, budgets, regressions_only)
    verdict = judge(measurement.median_ms, limit_ms, budget_ms, enforced)
    if regressions_only and budget_ms is None:
        verdict = NO_BUDGET
    return Row(target, measurement, limit_ms, budget_ms, text, verdict)


def render(rows: list[Row], key: str) -> str:
    def ms(value: float | None, digits: str = ".1f") -> str:
        return "-" if value is None else f"{value:{digits}} ms"

    cells = [("target", "min", "median", "limit", "budget", "verdict")] + [
        (
            TITLES[r.target],
            ms(r.measurement and r.measurement.min_ms),
            ms(r.measurement and r.measurement.median_ms),
            r.limit_text,
            ms(r.budget_ms, "g"),
            r.verdict,
        )
        for r in rows
    ]
    widths = [max(len(line[i]) for line in cells) for i in range(6)]
    table = [" | ".join(c.ljust(w) for c, w in zip(line, widths)).rstrip() for line in cells]
    notes = [f"  {TITLES[r.target]}: {d}" for r in rows if r.measurement
             for d in r.measurement.detail]
    return "\n".join([*table, *notes, f"machine: {key}"])


def rows_json(rows: list[Row], key: str, code: int) -> dict:
    def entry(row: Row) -> dict:
        m = row.measurement
        return {
            "target": row.target,
            "title": TITLES[row.target],
            "minMs": m and m.min_ms,
            "medianMs": m and m.median_ms,
            "limitMs": row.limit_ms,
            "budgetMs": row.budget_ms,
            "verdict": row.verdict,
            "detail": list(m.detail) if m else [],
        }

    return {"machine": key, "exitCode": code, "rows": [entry(r) for r in rows]}


def working_json(path: str) -> dict:
    file = REPO_ROOT / path
    return json.loads(file.read_text()) if file.is_file() else {}


def git_json(ref: str, path: str) -> dict:
    command = ["git", "show", f"{ref}:{path}"]
    shown = subprocess.run(command, cwd=REPO_ROOT, capture_output=True, text=True)
    return json.loads(shown.stdout) if shown.returncode == 0 else {}


def check_ratchet(ref: str) -> int:
    verify = ["git", "rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}"]
    known = subprocess.run(verify, cwd=REPO_ROOT, capture_output=True)
    if known.returncode != 0:
        print(f"unknown --base-ref {ref}", file=sys.stderr)
        return 2
    try:
        offenders = [line for path, keys in CEILING_KEYS.items() for line in
                     ratchet_offenders(path, git_json(ref, path), working_json(path), keys)]
    except ValueError as error:
        print(f"a budget file is not valid JSON: {error}", file=sys.stderr)
        return 2
    print("\n".join(offenders) if offenders else f"ratchet ok against {ref}")
    return 1 if offenders else 0


def minimum_runs(text: str) -> int:
    runs = int(text)
    if runs < MIN_RUNS:
        raise argparse.ArgumentTypeError(f"{runs} runs: fewer than {MIN_RUNS} is not a measurement")
    return runs


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Performance scorecard (#6147).")
    parser.add_argument("--targets", default=",".join(TITLES))
    parser.add_argument("--runs", type=minimum_runs, default=MIN_RUNS)
    parser.add_argument("--raw-dir", type=Path, default=REPO_ROOT / "test-fixtures/raws")
    parser.add_argument("--work-dir", type=Path)
    parser.add_argument("--json", type=Path, dest="json_out")
    parser.add_argument(
        "--machine-class",
        help="judge against this budget entry instead of the machine's CPU model (CI runners)",
    )
    parser.add_argument(
        "--regressions-only",
        action="store_true",
        help="fail only on a budget, and on a limit only where the budgets file says limitMet",
    )
    parser.add_argument("--check-ratchet", action="store_true")
    parser.add_argument("--base-ref")
    args = parser.parse_args(argv)
    args.targets = args.targets.split(",")
    unknown = [t for t in args.targets if t not in TITLES]
    if unknown:
        parser.error(f"unknown targets: {', '.join(unknown)}")
    if args.check_ratchet and not args.base_ref:
        parser.error("--check-ratchet needs --base-ref")
    return args


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    if args.check_ratchet:
        return check_ratchet(args.base_ref)
    try:
        budgets = json.loads((REPO_ROOT / SCORECARD_BUDGETS).read_text())
        listing = json.loads((REPO_ROOT / LISTING_BUDGETS).read_text())
    except (OSError, ValueError) as error:
        print(f"cannot read the budget files: {error}", file=sys.stderr)
        return 2
    key = args.machine_class or machine_key(sys.platform, platform.machine(), detect_cpu_model())
    work_dir = args.work_dir or Path(tempfile.mkdtemp(prefix="maple-scorecard-"))
    work_dir.mkdir(parents=True, exist_ok=True)
    try:
        env = Env(args.raw_dir, work_dir, args.runs, raw_free=args.machine_class is not None)
        rows = [
            build_row(t, env, budgets, listing, key, regressions_only=args.regressions_only)
            for t in args.targets
        ]
    finally:
        if args.work_dir is None:
            shutil.rmtree(work_dir, ignore_errors=True)
    code = exit_code(rows, args.regressions_only)
    print(render(rows, key))
    if args.json_out:
        args.json_out.write_text(json.dumps(rows_json(rows, key, code), indent=2) + "\n")
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
