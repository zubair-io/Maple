#!/usr/bin/env python3
"""Tests for perf_scorecard.py (#6147). Run: python3 src/scripts/perf_scorecard_test.py"""

import contextlib
import io
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import perf_scorecard as sc

KEY = "darwin-arm64 Apple M5 Max"
FFI_OUTPUT = """raw=/x/test_0007.DNG runs=5 threads=18
FFI preview_embedded_1280_jpeg  min  41.2 ms  median  43.9 ms  digest 00ab12cd34ef5678
FFI develop_fallback_1280_jpeg  min  120.0 ms  median  131.5 ms  digest 1111222233334444
"""
LISTING_BUDGET_FILE = {
    "targetWarmMedianMs": 100,
    "scenario": {"photos": 2000, "sidecars": 1000, "indexed": True, "withThumbs": True, "runs": 30},
    "limit500Images": 333,
    "machines": {},
}
LISTING_REPORT = {
    "photos": 2000, "sidecars": 1000, "indexed": True, "withThumbs": True,
    "warm": {"wallMin": 40.5, "wallMedian": 46, "serverMedian": 30, "status": 200, "bytes": 900},
    "responses": {"warmStatus": 200, "revalidateStatus": 304, "limit500Status": 200,
                  "imagesListed": 2000, "limit500Listed": 333},
}
LISTING_OUTPUT = "server listening\n" + json.dumps(LISTING_REPORT) + "\n"
BUDGETS = {
    "targets": {
        "preview": {"limitMs": 150, "machines": {KEY: {"budgetMs": 160}}},
        "export": {
            "limitFractionOfBaseline": 0.7,
            "machines": {KEY: {"baselineMs": 4000, "budgetMs": 2900}},
        },
        "cold_launch": {"limitMs": 1000},
        "grid_scroll": {"limitDroppedFrames": 0},
    }
}
LISTING = {"targetWarmMedianMs": 100, "machines": {KEY: {"warmMedianMs": 51}}}
ENV = sc.Env(Path("/raws"), Path("/work"), 5)


def raises(exception, call, *args):
    try:
        with contextlib.redirect_stderr(io.StringIO()):
            call(*args)
    except exception as error:
        return error
    raise AssertionError(f"{exception.__name__} was not raised")


def row_for(target, median_ms, key=KEY):
    measurer = {target: lambda env: sc.Measurement(median_ms - 1, median_ms)}
    return sc.build_row(target, ENV, BUDGETS, LISTING, key, measurer)


def test_median_and_min_pick_the_upper_middle():
    assert sc.median([5.0, 1.0, 3.0]) == 3.0
    assert sc.median([4.0, 1.0, 3.0, 2.0]) == 3.0


def test_parse_ffi_line_reads_the_named_case():
    measured = sc.parse_ffi_line(FFI_OUTPUT, "develop_fallback_1280_jpeg")
    assert (measured.min_ms, measured.median_ms) == (120.0, 131.5)


def test_parse_ffi_line_without_the_case_is_not_measured():
    raises(sc.NotMeasured, sc.parse_ffi_line, FFI_OUTPUT, "export_full_jpeg_default")


def listing_with(**changes):
    report = {**LISTING_REPORT, **changes}
    return "server listening\n" + json.dumps(report) + "\n"


def test_parse_listing_reads_the_warm_samples():
    measured = sc.parse_listing(LISTING_OUTPUT, LISTING_BUDGET_FILE)
    assert (measured.min_ms, measured.median_ms) == (40.5, 46.0)


def test_parse_listing_rejects_garbage():
    raises(sc.NotMeasured, sc.parse_listing, "not json", LISTING_BUDGET_FILE)
    raises(sc.NotMeasured, sc.parse_listing, "", LISTING_BUDGET_FILE)


def test_a_listing_that_got_fast_by_breaking_is_not_measured():
    responses = LISTING_REPORT["responses"]
    broken = {
        "an empty list": {**responses, "imagesListed": 0},
        "a truncated list": {**responses, "imagesListed": 1999},
        "a truncated page": {**responses, "limit500Listed": 0},
        "a failed warm request": {**responses, "warmStatus": 500},
        "a changed revalidation": {**responses, "revalidateStatus": 200},
        "a failed page": {**responses, "limit500Status": 404},
    }
    for name, changed in broken.items():
        error = raises(sc.NotMeasured, sc.parse_listing, listing_with(responses=changed),
                       LISTING_BUDGET_FILE)
        assert "not the one the budget is for" in str(error), name
    assert raises(sc.NotMeasured, sc.parse_listing, listing_with(photos=100), LISTING_BUDGET_FILE)
    no_facts = {key: value for key, value in LISTING_REPORT.items() if key != "responses"}
    assert raises(sc.NotMeasured, sc.parse_listing, json.dumps(no_facts), LISTING_BUDGET_FILE)


def test_machine_key_maps_arch_and_names_the_cpu():
    assert sc.machine_key("darwin", "arm64", " Apple M5 Max ") == KEY
    assert sc.machine_key("linux", "x86_64", "AMD EPYC") == "linux-x64 AMD EPYC"
    assert sc.machine_key("linux", "aarch64", "Neoverse") == "linux-arm64 Neoverse"
    assert sc.machine_key("win32", "AMD64", "Ryzen") == "win32-x64 Ryzen"


def test_machine_key_without_a_cpu_name_shares_one_key():
    assert sc.machine_key("linux", "x86_64", None) == "linux-x64 unknown CPU"
    assert sc.machine_key("linux", "x86_64", "Unknown") == "linux-x64 unknown CPU"


def test_judge_covers_every_verdict():
    assert sc.judge(90, 100, 95) == sc.OK
    assert sc.judge(101, 100, 200) == sc.OVER_LIMIT
    assert sc.judge(96, 100, 95) == sc.OVER_BUDGET
    assert sc.judge(90, None, 95) == sc.NO_LIMIT
    assert sc.judge(90, 100, None) == sc.NO_BUDGET
    assert sc.judge(101, 100, None) == sc.OVER_LIMIT


def test_without_enforcing_the_limit_only_a_budget_fails():
    assert sc.judge(200, 150, 300, enforce_limit=False) == sc.TARGET_NOT_MET
    assert sc.judge(301, 150, 300, enforce_limit=False) == sc.OVER_BUDGET
    assert sc.judge(120, 150, 300, enforce_limit=False) == sc.OK
    assert sc.judge(200, 150, None, enforce_limit=False) == sc.TARGET_NOT_MET


def test_regressions_only_enforces_the_limit_just_where_it_is_met():
    budgets = {"targets": {"listing": {"limitMet": True}, "preview": {"limitMet": False},
                           "export": {}}}
    assert sc.enforces_limit("listing", budgets, regressions_only=True)
    assert not sc.enforces_limit("preview", budgets, regressions_only=True)
    assert not sc.enforces_limit("export", budgets, regressions_only=True)
    assert sc.enforces_limit("preview", budgets, regressions_only=False)


def test_a_regressions_only_row_keeps_a_target_that_is_not_met_green_until_its_budget():
    budgets = {"targets": {"preview": {"limitMet": False, "limitMs": 150,
                                       "machines": {KEY: {"budgetMs": 300}}}}}
    def build(median_ms):
        measurer = {"preview": lambda env: sc.Measurement(median_ms - 1, median_ms)}
        return sc.build_row("preview", ENV, budgets, LISTING, KEY, measurer, regressions_only=True)
    assert build(200).verdict == sc.TARGET_NOT_MET
    assert build(301).verdict == sc.OVER_BUDGET
    assert sc.exit_code([build(200)]) == 0


def test_a_regressions_only_row_without_a_budget_is_not_judgeable():
    budgets = {"targets": {"export": {"limitMet": False,
                                      "machines": {KEY: {"baselineMs": 4000, "budgetMs": 2900}}}}}
    measurer = {"export": lambda env: sc.Measurement(1, 2)}
    typo = sc.build_row("export", ENV, budgets, LISTING, "ci-typo", measurer, regressions_only=True)
    assert typo.verdict == sc.NO_BUDGET
    assert sc.exit_code([typo], regressions_only=True) == 2
    assert sc.exit_code([typo], regressions_only=False) == 0


def test_a_target_at_its_limit_is_within_it():
    assert sc.judge(100, 100, 100) == sc.OK


def test_export_limit_is_a_fraction_of_the_machine_baseline():
    assert sc.limits_for("export", BUDGETS, LISTING, KEY) == (0.7 * 4000, 2900)
    assert sc.limits_for("export", BUDGETS, LISTING, "other") == (None, None)
    assert row_for("export", 2801).verdict == sc.OVER_LIMIT
    assert row_for("export", 2801, "other").verdict == sc.NO_LIMIT


def test_listing_limit_and_budget_come_from_the_listing_budget_file():
    assert sc.limits_for("listing", BUDGETS, LISTING, KEY) == (100, 51)
    assert row_for("listing", 52).verdict == sc.OVER_BUDGET


def test_a_target_without_a_runner_is_not_measured():
    row = sc.build_row("cold_launch", ENV, BUDGETS, LISTING, KEY, {})
    assert row.verdict == "NOT MEASURED (no committed runner, see #6146)"
    assert row.limit_ms == 1000
    grid = sc.build_row("grid_scroll", ENV, BUDGETS, LISTING, KEY, {})
    assert grid.limit_text == "0 dropped frames"


def test_grid_scroll_names_the_script_that_measures_it():
    grid = sc.build_row("grid_scroll", ENV, BUDGETS, LISTING, KEY, {})
    assert "measure_grid_scroll.sh" in grid.verdict and "#6146" in grid.verdict


def test_a_missing_tool_is_not_measured_with_its_reason():
    def missing(env):
        raise sc.NotMeasured("ffi-perf is missing")

    row = sc.build_row("preview", ENV, BUDGETS, LISTING, KEY, {"preview": missing})
    assert row.verdict == "NOT MEASURED (ffi-perf is missing)"
    assert row.measurement is None


def row(verdict):
    return sc.Row("listing", None, None, None, "-", verdict)


def test_exit_code_rules():
    assert sc.exit_code([row(sc.OK), row(sc.NO_BUDGET), row(sc.NO_LIMIT)]) == 0
    assert sc.exit_code([row(sc.OK), row(sc.OVER_BUDGET)]) == 1
    assert sc.exit_code([row(sc.OK), row("NOT MEASURED (x)")]) == 2
    assert sc.exit_code([row(sc.OVER_LIMIT), row("NOT MEASURED (x)")]) == 1


def test_default_targets_are_all_six_and_runs_default_to_five():
    args = sc.parse_args([])
    assert args.targets == list(sc.TITLES) and len(args.targets) == 6
    assert args.runs == 5


def test_fewer_than_five_runs_is_rejected_with_exit_2():
    assert raises(SystemExit, sc.parse_args, ["--runs", "4"]).code == 2
    assert sc.parse_args(["--runs", "5"]).runs == 5


def test_machine_class_and_regressions_only_are_options_and_strict_is_gone():
    args = sc.parse_args(["--machine-class", "ci-linux-x64", "--regressions-only"])
    assert args.machine_class == "ci-linux-x64" and args.regressions_only
    assert raises(SystemExit, sc.parse_args, ["--strict"]).code == 2


def test_unknown_target_and_ratchet_without_base_ref_are_usage_errors():
    assert raises(SystemExit, sc.parse_args, ["--targets", "bogus"]).code == 2
    assert raises(SystemExit, sc.parse_args, ["--check-ratchet"]).code == 2


def offenders(base, now):
    keys = sc.CEILING_KEYS[sc.SCORECARD_BUDGETS]
    return sc.ratchet_offenders("budgets", base, now, keys)


def with_budget(value, limit=150):
    machine = {"measured": "note", "budgetMs": value}
    return {"targets": {"preview": {"limitMs": limit, "machines": {KEY: machine}}}}


def test_ratchet_lowering_or_keeping_passes():
    assert offenders(with_budget(100), with_budget(90)) == []
    assert offenders(with_budget(100), with_budget(100)) == []


def test_ratchet_raising_a_budget_or_limit_fails():
    assert len(offenders(with_budget(100), with_budget(101))) == 1
    assert len(offenders(with_budget(100), with_budget(100, limit=151))) == 1


def test_ratchet_removing_a_budget_machine_or_limit_fails():
    assert len(offenders(with_budget(100), {"targets": {"preview": {"limitMs": 150}}})) == 1
    assert len(offenders(with_budget(100), {})) == 2


def test_ratchet_adding_entries_or_a_missing_base_passes():
    grown = with_budget(100)
    grown["targets"]["preview"]["machines"]["linux-x64 New"] = {"budgetMs": 500}
    grown["targets"]["export"] = {"limitFractionOfBaseline": 0.7}
    assert offenders(with_budget(100), grown) == []
    assert offenders({}, with_budget(100)) == []


def test_ratchet_fails_when_a_met_limit_is_unmarked_or_the_flag_is_dropped():
    met = {"targets": {"listing": {"limitMet": True}, "preview": {"limitMet": False}}}
    unmarked = {"targets": {"listing": {"limitMet": False}, "preview": {"limitMet": False}}}
    dropped = {"targets": {"preview": {"limitMet": False}}}
    promoted = {"targets": {"listing": {"limitMet": True}, "preview": {"limitMet": True}}}
    keys = sc.CEILING_KEYS[sc.SCORECARD_BUDGETS]
    assert sc.ratchet_offenders("f", met, unmarked, keys) == ["f: targets/listing/limitMet "
                                                              "was true and is no longer"]
    assert len(sc.ratchet_offenders("f", met, dropped, keys)) == 1
    assert sc.ratchet_offenders("f", met, promoted, keys) == []


def test_without_a_machine_class_the_camera_raw_is_required_and_with_one_it_is_not_used():
    assert raises(sc.NotMeasured, sc.camera_raw, sc.Env(Path("/nowhere"), Path("/w"), 5))
    assert sc.camera_raw(sc.Env(Path("/nowhere"), Path("/w"), 5, raw_free=True)) is None


def test_ratchet_ignores_notes_and_scenario_counts():
    listing_keys = sc.CEILING_KEYS[sc.LISTING_BUDGETS]
    base = {"limit500Images": 333, "scenario": {"runs": 30}, "machines": {KEY: {"measured": "a"}}}
    now = {"limit500Images": 999, "scenario": {"runs": 99}, "machines": {KEY: {"measured": "b"}}}
    assert sc.ratchet_offenders("listing", base, now, listing_keys) == []


def test_committed_budgets_hold_every_limit_the_scorecard_reads():
    budgets = json.loads((sc.REPO_ROOT / sc.SCORECARD_BUDGETS).read_text())
    listing = json.loads((sc.REPO_ROOT / sc.LISTING_BUDGETS).read_text())
    limits = {t: sc.limits_for(t, budgets, listing, KEY)[0] for t in sc.TITLES}
    assert limits["listing"] == 100 and limits["preview"] == 150
    assert limits["cold_launch"] == 1000 and limits["lan_thumbnails"] == 2000
    assert budgets["targets"]["grid_scroll"]["limitDroppedFrames"] == 0
    assert budgets["targets"]["export"]["limitFractionOfBaseline"] == 0.7
    this_machine = {t: sc.limits_for(t, budgets, listing, KEY) for t in sc.TITLES}
    assert this_machine["export"][0] == 0.7 * 4042
    assert all(this_machine[t][1] is not None for t in ("listing", "preview", "export"))


def test_render_lists_rows_and_the_machine():
    rows = [row_for("preview", 140), sc.build_row("cold_launch", ENV, BUDGETS, LISTING, KEY, {})]
    text = sc.render(rows, KEY)
    assert "1280 px camera preview render" in text and "139.0 ms" in text
    assert "NOT MEASURED (no committed runner, see #6146)" in text
    assert text.splitlines()[-1] == f"machine: {KEY}"


def main() -> int:
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_")]
    failed = 0
    for name, test in tests:
        try:
            test()
            print(f"PASS {name}")
        except AssertionError as error:
            failed += 1
            print(f"FAIL {name}: {error}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
