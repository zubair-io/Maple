#!/usr/bin/env python3
"""Render the committed per-device perf rows under test-fixtures/perf/ into
docs/performance.md (#3421).

Every row this script reads was written by a real harness run — Apple's
`EditorWorkflowPerfTests` (see `PerfRecordWriter.swift`,
`MAPLE_PERF_RECORD=<path>`) today, with the same JSON shape open to other
platforms' harnesses later. This script only formats; it computes no new
numbers and fabricates none — a platform with no committed row gets no
section, not a placeholder.

Usage:
    python3 tools/perf-table.py

Reads every test-fixtures/perf/<platform>/*.json, writes docs/performance.md.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
PERF_DIR = REPO_ROOT / "test-fixtures" / "perf"
OUTPUT = REPO_ROOT / "docs" / "performance.md"

# CLAUDE.md "Performance invariants" / SliderTickPerfHarness spec constants —
# duplicated here as plain numbers (not imported) because this script has no
# dependency on the Swift or Rust trees. Keep in sync by hand; a drift here
# only misdescribes a target column, it never changes what's gated.
TICK_TARGET_MS = 16.0
TICK_HARD_MS = 50.0
COLD_OPEN_CACHED_TARGET_MS = 35.0
COLD_OPEN_UNCACHED_TARGET_RANGE = (250.0, 1000.0)

PLATFORM_TITLES = {
    "apple-macos": "macOS",
    "apple-ios": "iOS / iPadOS",
    "web-chrome": "Web (Chrome)",
    "windows": "Windows",
}


def load_rows() -> dict[str, list[dict[str, Any]]]:
    """One list of rows per platform directory. A file may hold a single
    row object or an array of rows (`PerfRecordWriter` always writes an
    array; tolerate a bare object too so a hand-written row doesn't need
    the wrapper)."""
    rows_by_platform: dict[str, list[dict[str, Any]]] = {}
    if not PERF_DIR.is_dir():
        return rows_by_platform
    for platform_dir in sorted(PERF_DIR.iterdir()):
        if not platform_dir.is_dir():
            continue
        platform_rows: list[dict[str, Any]] = []
        for json_path in sorted(platform_dir.glob("*.json")):
            data = json.loads(json_path.read_text())
            entries = data if isinstance(data, list) else [data]
            for entry in entries:
                entry = dict(entry)
                entry.setdefault("platform", platform_dir.name)
                entry["_sourceFile"] = str(json_path.relative_to(REPO_ROOT))
                platform_rows.append(entry)
        if platform_rows:
            rows_by_platform[platform_dir.name] = platform_rows
    return rows_by_platform


def fmt_ms(value: Any) -> str:
    if value is None:
        return "—"
    try:
        return f"{float(value):,.1f} ms"
    except (TypeError, ValueError):
        return str(value)


def fmt_int(value: Any) -> str:
    if value is None:
        return "—"
    try:
        return str(int(value))
    except (TypeError, ValueError):
        return str(value)


def tick_rows(label: str, tick: dict[str, Any] | None, published_of: Any) -> list[str]:
    if not tick:
        return [f"| {label} p50 / p95 / max | — | 16 ms / 50 ms (hard) |"]
    p50, p95, mx = tick.get("p50Ms"), tick.get("p95Ms"), tick.get("maxMs")
    over16, published = tick.get("over16"), tick.get("published")
    return [
        (
            f"| {label} tick p50 / p95 / max | "
            f"{fmt_ms(p50)} / {fmt_ms(p95)} / {fmt_ms(mx)} | "
            f"{TICK_TARGET_MS:g} ms / {TICK_HARD_MS:g} ms (hard) |"
        ),
        (
            f"| {label} ticks over 16 ms | "
            f"{fmt_int(over16)} of {fmt_int(published)} published | 0 |"
        ),
    ]


def render_row_section(row: dict[str, Any]) -> str:
    device = row.get("deviceModel", row.get("deviceId", "unknown device"))
    chip = row.get("chip", "unknown")
    gpu = row.get("gpu", "unknown")
    os_version = row.get("osVersion", "unknown")
    refresh = row.get("refreshRateHz")
    thermal = row.get("thermalState", "unknown")
    fixture = row.get("fixture", "unknown")
    profile = row.get("profile", "unknown")
    viewport_w = row.get("viewportWidth")
    viewport_h = row.get("viewportHeight")
    cache_state = row.get("cacheState", "unknown")
    harness = row.get("harness", "unknown")
    commit = row.get("commitSha", "unknown")
    date = row.get("date", "unknown")
    source = row.get("_sourceFile", "unknown")
    recording_note = row.get("recordingNote")

    lines = [
        f"### {device} — {fixture} — {profile}",
        "",
        (
            f"Chip **{chip}** · GPU **{gpu}** · {os_version} · "
            f"{refresh if refresh else '?'} Hz display · thermal state at record time: "
            f"**{thermal}**. Viewport {fmt_int(viewport_w)}×{fmt_int(viewport_h)} px. "
            f"Cache methodology: `{cache_state}`. Harness `{harness}` at commit "
            f"`{commit[:12] if isinstance(commit, str) else commit}`, recorded {date}. "
            f"Source row: [`{source}`](../{source})."
        ),
        "",
        "| Measurement | This device | Spec target |",
        "| --- | --- | --- |",
        (
            f"| Cold open, uncached | {fmt_ms(row.get('coldOpenUncachedMs'))} | "
            f"{COLD_OPEN_UNCACHED_TARGET_RANGE[0]:g}–"
            f"{COLD_OPEN_UNCACHED_TARGET_RANGE[1]:g} ms |"
        ),
        (
            f"| Cold open, cached reopen | {fmt_ms(row.get('coldOpenCachedMs'))} | "
            f"~{COLD_OPEN_CACHED_TARGET_MS:g} ms |"
        ),
        *tick_rows("Exposure", row.get("tickExposure"), row.get("tickExposure", {}).get("published")),
        *tick_rows("Contrast", row.get("tickContrast"), row.get("tickContrast", {}).get("published")),
        (
            f"| Full-resolution export ({row.get('exportFormat', 'jpeg')}) | "
            f"{fmt_ms(row.get('exportMs'))} | no fixed target — tracked for regression |"
        ),
    ]
    if recording_note:
        lines += ["", f"> **Recording conditions:** {recording_note}"]
    return "\n".join(lines)


def render(rows_by_platform: dict[str, list[dict[str, Any]]]) -> str:
    parts = [
        "# Performance",
        "",
        "Committed, reproducible per-device measurements of the product's real",
        "performance invariants (CLAUDE.md \"Performance invariants\"): slider-tick",
        "latency, cold-open latency, and full-resolution export time, on the 100 MP",
        "reference RAW where the fixture is present. **Generated** by",
        "`tools/perf-table.py` from the committed rows under `test-fixtures/perf/`",
        "— do not hand-edit the tables below; edit a row's JSON file and",
        "regenerate. See [testing.md](testing.md) for the rest of the gate map and",
        "[apple.md](apple.md) § \"Measuring editor latency\" for the Apple harness",
        "internals.",
        "",
        "## Method and what these numbers exclude",
        "",
        "Every row comes from a named harness (`EditorWorkflowPerfTests` on Apple",
        "today) driving the production `EditSession` → `RenderActor` →",
        "`GpuLiveDriver` path on an isolated copy of the reference RAW — not a",
        "synthetic microbenchmark. Per `docs/apple.md` § \"Measuring editor",
        "latency\":",
        "",
        "- Tick timings capture model-input to publish acknowledgement — **not**",
        "  compositor scanout or SwiftUI gesture dispatch. They exclude device",
        "  scanout and real touch/mouse gesture latency; pair with an Instruments",
        "  trace for that end of the pipeline.",
        "- A 1 ms polling task observes publication and can itself miss",
        "  publications if delayed, adding observation latency on top of the",
        "  real render time.",
        "- \"Cold open, cached reopen\" opens a **second, brand-new** `EditSession`",
        "  (with its own GPU-live session, Metal layer, and window) against the",
        "  same staged asset after the first session's exit-readback has",
        "  populated the on-disk `RenderedPreviewCache` and the in-process memory",
        "  tier has been dropped (`handleMemoryPressure`). It is a real disk-cache",
        "  hit, but it still pays full `EditSession`/GPU-session/window bring-up",
        "  cost on every run — a warm in-app reopen (the ~35 ms CLAUDE.md target)",
        "  has none of that bring-up cost, so this number is expected to run",
        "  noticeably higher than 35 ms even on a hit.",
        "- The correctness assertions inside the harness (e.g. \"same-session",
        "  revisit reuses the decode\") do not certify a universal 16 ms display",
        "  budget on every machine; they gate the one machine that ran them.",
        "- Numbers here are single machine-local runs, not a fleet average or a",
        "  percentile across hardware. Two back-to-back runs on the same machine",
        "  can differ by 2–3× under concurrent CPU load from unrelated work (see",
        "  \"Recording methodology\" below) — treat one row as a spot check, not a",
        "  SLA.",
        "",
        "## Recording methodology",
        "",
        "Each committed row is the **better of two consecutive runs** on the same",
        "machine, immediately back to back — not an average, not a best-of-many.",
        "The two runs are logged (see the PR that added the row) so a reader can",
        "see the spread the \"better of two\" was chosen from. This repo's own",
        "recording session for the rows below ran alongside multiple other",
        "concurrent `cargo`/`swift build` processes from unrelated sessions on the",
        "same Mac, which inflated both runs — flagged per platform below where it",
        "applies.",
        "",
        "## Recording a new row",
        "",
        "```bash",
        "# Apple (macOS/iPadOS) — from repo root, after building the release xcframework:",
        "cd src/apple/Packages/MapleCore",
        "swift build -c release --build-tests -Xswiftc -enable-testing",
        "MAPLE_PERF=1 MAPLE_PERF_RECORD=\"$PWD/../../../../test-fixtures/perf/apple-macos/<device-id>.json\" \\",
        "  swift test -c release --skip-build -Xswiftc -enable-testing --filter EditorWorkflowPerfTests",
        "```",
        "",
        "`<device-id>` is the machine's `hw.model` with `,` replaced by `-` (e.g.",
        "`Mac17-6`) — `PerfRecordWriter.deviceIdSlug` computes the same string, so",
        "matching the filename to the row's own `deviceId` field is a good sanity",
        "check. Run it twice, keep the better run's file, then regenerate this",
        "document:",
        "",
        "```bash",
        "python3 tools/perf-table.py",
        "```",
        "",
        "## Regression gate (local only)",
        "",
        "```bash",
        "python3 tools/check-perf-ratchet.py <fresh-row.json> <committed-row.json>",
        "```",
        "",
        "Fails when a fresh run's tick p95/max, cold-open, or export time",
        "regresses past the committed row by more than a jitter margin — see",
        "`tools/check-perf-ratchet.py`'s header for the exact margins and why",
        "they're that wide. **This never runs in cloud CI.** Apple tests are not",
        "cloud-gated at all (`docs/apple.md` § \"Build and test\" — cloud CI compiles",
        "MapleCore only, no test target runs there), so a machine-dependent",
        "absolute-time gate has no CI machine to be stable on; it is a local,",
        "pre-PR sanity check the way `SliderTickPerfTests`' in-run ON/OFF ratio",
        "(#2113) is the machine-independent one that actually can run anywhere.",
        "That in-run ratio gate is unrelated to this file and is untouched by it.",
        "",
    ]

    if not rows_by_platform:
        parts.append(
            "_No perf rows are committed yet. Run the recording command above for "
            "at least one platform, then regenerate this file._\n"
        )
        return "\n".join(parts)

    for platform in sorted(rows_by_platform):
        title = PLATFORM_TITLES.get(platform, platform)
        parts.append(f"## {title}")
        parts.append("")
        for row in rows_by_platform[platform]:
            parts.append(render_row_section(row))
            parts.append("")

    parts.append(GAPS_SECTION)
    return "\n".join(parts).rstrip() + "\n"


# Hand-maintained (not derived from the committed rows) — every platform the
# ticket asked for that has no row yet, and exactly why, so a reader isn't
# left assuming the omission is an oversight. Update this alongside adding
# that platform's first row.
GAPS_SECTION = """## Platforms without a committed row yet

- **iPad.** No physical iPad was available on the machine that recorded the
  rows above. `EditorWorkflowPerfTests` runs unmodified against an iOS
  Simulator or device destination the same way it runs on macOS — see
  `docs/apple.md` § "Build and test" for the `-destination 'platform=iOS
  Simulator,name=...'` invocation — recording a row is a matter of running it
  there and committing the resulting `test-fixtures/perf/apple-ios/<device-id>.json`.
- **Windows.** No WinUI tick-qualification harness (#2587) writes this JSON
  row shape yet. `docs/windows.md` documents the existing Windows test setup;
  wiring its output into this format is separate follow-up work.
- **Web (Chrome), on the 100 MP reference specifically.** The production
  Chrome audit harness (`src/web/e2e/production/raw-performance.spec.ts`,
  from #2457) measures real slider-tick and cold-open numbers, but not
  against `dji-mavic3pro-100mp.dng`: its own comment on `OVER_BUDGET_RAW`
  records why — "The 100 MP reference fixture reproduces the same abort but
  its 129 MB payload crashes the renderer inside the folder-picker shim's
  base64 CDP bridge, so the e2e uses the largest canonical fixture the
  bridge can carry" (`test_0003.CR2`, 52.7 MP). The harness's own slider-tick
  budget test (`raw-gpu-performance`) runs against the smaller `test_0006.DNG`
  fixture instead. A web row on the 100 MP reference needs either a bridge
  fix for the picker shim's base64 payload size or a non-picker file-intake
  path for the e2e harness — tracked as follow-up, not fabricated here.
"""


def main() -> int:
    rows_by_platform = load_rows()
    OUTPUT.write_text(render(rows_by_platform))
    total = sum(len(v) for v in rows_by_platform.values())
    print(f"Wrote {OUTPUT.relative_to(REPO_ROOT)} — {total} row(s) across {len(rows_by_platform)} platform(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
