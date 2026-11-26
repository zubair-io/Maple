#!/usr/bin/env python3
"""Render the committed per-device perf rows under test-fixtures/perf/ into
docs/performance.md (#3421).

Every row this script reads was written by a real harness run — Apple's
`EditorWorkflowPerfTests` (see `PerfRecordWriter.swift`,
`MAPLE_PERF_RECORD=<path>`) today, with the same JSON shape open to other
platforms' harnesses later. The engine-only GPU live-chain section is read
from the raw stdout of `raw-gpu/examples/detail-live-timing.rs` committed under
test-fixtures/perf/gpu-live-engine/<device>/. This script only formats and
takes medians and differences of those committed numbers; it fabricates none
— a platform with no committed row gets no section, not a placeholder.

Usage:
    python3 tools/perf-table.py

Reads every test-fixtures/perf/<platform>/*.json and
test-fixtures/perf/gpu-live-engine/<device>/, writes docs/performance.md.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
PERF_DIR = REPO_ROOT / "test-fixtures" / "perf"
OUTPUT = REPO_ROOT / "docs" / "performance.md"
ENGINE_DIR_NAME = "gpu-live-engine"

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
        if not platform_dir.is_dir() or platform_dir.name == ENGINE_DIR_NAME:
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


def tick_rows(label: str, tick: dict[str, Any] | None) -> list[str]:
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
        *tick_rows("Exposure", row.get("tickExposure")),
        *tick_rows("Contrast", row.get("tickContrast")),
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
        'performance invariants (CLAUDE.md "Performance invariants"): slider-tick',
        "latency, cold-open latency, and full-resolution export time, on the 100 MP",
        "reference RAW where the fixture is present. **Generated** by",
        "`tools/perf-table.py` from the committed rows under `test-fixtures/perf/`",
        "— do not hand-edit the tables below; edit a row's JSON file and",
        "regenerate. See [testing.md](testing.md) for the rest of the gate map and",
        '[apple.md](apple.md) § "Measuring editor latency" for the Apple harness',
        "internals.",
        "",
        "## Method and what these numbers exclude",
        "",
        "Every row comes from a named harness (`EditorWorkflowPerfTests` on Apple",
        "today) driving the production `EditSession` → `RenderActor` →",
        "`GpuLiveDriver` path on an isolated copy of the reference RAW — not a",
        'synthetic microbenchmark. Per `docs/apple.md` § "Measuring editor',
        'latency":',
        "",
        "- Tick timings capture model-input to publish acknowledgement — **not**",
        "  compositor scanout or SwiftUI gesture dispatch. They exclude device",
        "  scanout and real touch/mouse gesture latency; pair with an Instruments",
        "  trace for that end of the pipeline.",
        "- A 1 ms polling task observes publication and can itself miss",
        "  publications if delayed, adding observation latency on top of the",
        "  real render time.",
        '- "Cold open, cached reopen" opens a **second, brand-new** `EditSession`',
        "  (with its own GPU-live session, Metal layer, and window) against the",
        "  same staged asset after the first session's exit-readback has",
        "  populated the on-disk `RenderedPreviewCache` and the in-process memory",
        "  tier has been dropped (`handleMemoryPressure`). It is a real disk-cache",
        "  hit, but it still pays full `EditSession`/GPU-session/window bring-up",
        "  cost on every run — a warm in-app reopen (the ~35 ms CLAUDE.md target)",
        "  has none of that bring-up cost, so this number is expected to run",
        "  noticeably higher than 35 ms even on a hit.",
        '- The correctness assertions inside the harness (e.g. "same-session',
        '  revisit reuses the decode") do not certify a universal 16 ms display',
        "  budget on every machine; they gate the one machine that ran them.",
        "- Numbers here are single machine-local runs, not a fleet average or a",
        "  percentile across hardware. Two back-to-back runs on the same machine",
        "  can differ by 2–3× under concurrent CPU load from unrelated work (see",
        '  "Recording methodology" below) — treat one row as a spot check, not a',
        "  SLA.",
        "",
        "## Recording methodology",
        "",
        "Each committed row is the **better of two consecutive runs** on the same",
        "machine, immediately back to back — not an average, not a best-of-many.",
        "The two runs are logged (see the PR that added the row) so a reader can",
        'see the spread the "better of two" was chosen from. This repo\'s own',
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
        'MAPLE_PERF=1 MAPLE_PERF_RECORD="$PWD/../../../../test-fixtures/perf/apple-macos/<device-id>.json" \\',
        "  swift test -c release --skip-build -Xswiftc -enable-testing --filter EditorWorkflowPerfTests",
        "```",
        "",
        "`<device-id>` is the machine's `hw.model` with `,` replaced by `-` (e.g.",
        "`Mac17-6`) — `PerfRecordWriter.deviceIdSlug` computes the same string, so",
        "matching the filename to the row's own `deviceId` field is a good sanity",
        "check. Run it twice, keep the better run's file, then regenerate this",
        "document and reformat it (the generator does not match prettier's",
        "markdown table column padding, so this second step is required — CI's",
        "format-check gate will otherwise flag the regenerated file):",
        "",
        "```bash",
        "python3 tools/perf-table.py",
        "cd src/web && bun run format && cd -",
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
        "they're that wide. **This absolute-time ratchet never runs in cloud CI.**",
        "Apple CI does execute selected MapleCore regressions against a real release",
        "Rust archive (see [Testing and CI](testing.md#what-ci-actually-builds-for-apple)).",
        "Those runs do not establish per-device performance: this ratchet needs the",
        "same reference device, fixture, viewport, thermal state and controlled load.",
        "It remains a local pre-PR check. `SliderTickPerfTests`' in-run ON/OFF ratio",
        "(#2113) is a separate relative check; its execution depends on the selected",
        "test classes, not on this report being generated.",
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

    parts.extend(render_engine_sections())
    parts.append(GAPS_SECTION)
    return "\n".join(parts).rstrip() + "\n"


LOAD_RE = re.compile(r"load averages?: ([0-9.]+)")
FIELD_RE = re.compile(r"(\w+)=(\S+)")


def parse_engine_run(path: Path) -> dict[str, Any]:
    """One `detail-live-timing` stdout, framed by the recording script's
    `load_start:` / `load_end:` lines (the 1-minute load average)."""
    run: dict[str, Any] = {"drags": {}, "sequences": {}}
    for line in path.read_text().splitlines():
        load = LOAD_RE.search(line)
        if line.startswith("load_start:") and load:
            run["load_start"] = float(load.group(1))
        elif line.startswith("load_end:") and load:
            run["load_end"] = float(load.group(1))
        fields = dict(FIELD_RE.findall(line))
        if "image" in fields:
            run["image"] = fields["image"]
            run["ticks"] = int(fields["ticks_per_drag"])
            run["adapter"] = fields["adapter"]
        elif "drag" in fields:
            run["drags"][(fields["model"], fields["drag"])] = fields
        elif "sequence" in fields:
            run["sequences"][fields["model"]] = fields
        elif line.startswith("copy "):
            run["copy"] = fields
    return run


def pad_table(rows: list[list[str]]) -> list[str]:
    widths = [max(len(row[i]) for row in rows) for i in range(len(rows[0]))]

    def cells(row: list[str]) -> str:
        return "| " + " | ".join(c.ljust(w) for c, w in zip(row, widths)) + " |"

    rule = "| " + " | ".join("-" * w for w in widths) + " |"
    return [cells(rows[0]), rule, *(cells(row) for row in rows[1:])]


def triple(fields: dict[str, str] | None) -> str:
    if not fields:
        return "—"
    return f"{float(fields['p50_ms']):.1f} / {float(fields['p95_ms']):.1f} / {float(fields['max_ms']):.1f}"


ENGINE_MODELS = {
    "default": "default",
    "engaged": "engaged",
    "engaged_creative": "engaged + creative stage",
}
ENGINE_DRAGS = {
    "exposure": "exposure (moves the prefix)",
    "contrast": "contrast",
    "whites": "whites",
    "grade_midtone_saturation": "colour grade saturation",
    "grain_amount": "grain amount",
}


def render_engine_device(device_dir: Path) -> str:
    meta = json.loads((device_dir / "run.json").read_text())
    runs = {
        path.stem: parse_engine_run(path)
        for path in sorted(device_dir.glob("round*-*-*.txt"))
    }
    rounds = sorted({stem.split("-")[0] for stem in runs})
    edges = sorted({int(stem.split("-")[2]) for stem in runs})

    def run(r: str, binary: str, edge: int) -> dict[str, Any]:
        return runs.get(f"{r}-{binary}-{edge}", {})

    def viewport(edge: int) -> str:
        images = (
            run(r, b, edge).get("image") for r in rounds for b in ("before", "after")
        )
        return next((image.replace("x", "×") for image in images if image), str(edge))

    lines = [
        f"### {meta['device']} — {meta['fixture']} — resume cut (#6021)",
        "",
        meta["method"],
        "",
    ]
    header = ["Viewport", "Model", "Drag"] + [
        f"{label} {r.removeprefix('round')} {binary} p50 / p95 / max (ms)"
        for r in rounds
        for binary, label in (("before", "Round"), ("after", "Round"))
    ]
    table = [header]
    for edge in edges:
        for model, model_label in ENGINE_MODELS.items():
            for drag, drag_label in ENGINE_DRAGS.items():
                table.append(
                    [viewport(edge), model_label, drag_label]
                    + [
                        triple(run(r, binary, edge).get("drags", {}).get((model, drag)))
                        for r in rounds
                        for binary in ("before", "after")
                    ]
                )
    lines += pad_table(table)
    lines += ["", meta["first_late_note"], ""]
    first = [
        [
            "Viewport",
            "Model",
            "Round",
            "Build",
            "Exposure tick p50 (ms)",
            "First late tick p50 / p95 (ms)",
        ]
    ]
    for edge in edges:
        for model, model_label in ENGINE_MODELS.items():
            for r in rounds:
                for binary in ("before", "after"):
                    seq = run(r, binary, edge).get("sequences", {}).get(model)
                    if seq:
                        first.append(
                            [
                                viewport(edge),
                                model_label,
                                r.removeprefix("round"),
                                binary,
                                f"{float(seq['exposure_p50_ms']):.1f}",
                                f"{float(seq['first_late_p50_ms']):.1f} / {float(seq['first_late_p95_ms']):.1f}",
                            ]
                        )
    lines += pad_table(first)
    lines += ["", meta["copy_note"], ""]
    copies = [
        [
            "Viewport",
            "Plane",
            "Round",
            "Build",
            "Copy + submit p50 (ms)",
            "Empty submit p50 (ms)",
            "Copy alone (ms)",
        ]
    ]
    for edge in edges:
        for r in rounds:
            for binary in ("before", "after"):
                copy = run(r, binary, edge).get("copy")
                if copy:
                    copies.append(
                        [
                            viewport(edge),
                            f"{int(copy['bytes']) / 1e6:.1f} MB",
                            r.removeprefix("round"),
                            binary,
                            copy["copy_submit_p50_ms"],
                            copy["empty_submit_p50_ms"],
                            copy["net_copy_ms"],
                        ]
                    )
    lines += pad_table(copies)
    lines += [
        "",
        "Recording load (1-minute load average at the start and end of each run):",
        "",
    ]
    loads = [
        ["Round", "Viewport", "Build", "Load at start", "Load at end", "Ticks per drag"]
    ]
    for r in rounds:
        for edge in edges:
            for binary in ("before", "after"):
                one = run(r, binary, edge)
                if one:
                    loads.append(
                        [
                            r.removeprefix("round"),
                            viewport(edge),
                            binary,
                            f"{one.get('load_start', 0):.1f}",
                            f"{one.get('load_end', 0):.1f}",
                            str(one.get("ticks", "—")),
                        ]
                    )
    lines += pad_table(loads)
    lines += ["", meta["caveat"], ""]
    return "\n".join(lines)


def render_engine_sections() -> list[str]:
    engine_dir = PERF_DIR / ENGINE_DIR_NAME
    devices = (
        sorted(d for d in engine_dir.iterdir() if (d / "run.json").is_file())
        if engine_dir.is_dir()
        else []
    )
    if not devices:
        return []
    return [
        "## GPU live chain, engine only (macOS)",
        "",
        *(render_engine_device(d) for d in devices),
    ]


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
- **Web (Chrome), on the 100 MP reference specifically.** The bounded folder-picker
  bridge and `src/web/e2e/production/raw-100mp.spec.ts` now exercise the exact
  `dji-mavic3pro-100mp.dng` through the production editor (#3669), validating its
  complete byte count and SHA-256 before opening. The smaller DNG slider and
  Canon CPU-fallback tests remain intact. The test attaches intake, host/browser/GPU,
  editor-open and worker-render evidence, including the failure stage if it fails;
  a missing canonical fixture is an explicit skip, never a smaller-file substitution.
  See [the recorded qualification](../test-fixtures/qualification/browser-100mp-3669.md).
  This is not a committed quiet-machine performance row: the initial recording had
  background sync activity, and worker `maple:session-render` intervals on a viewport
  are distinct from input-to-display latency or a full-resolution 100 MP frame.
"""


def main() -> int:
    rows_by_platform = load_rows()
    OUTPUT.write_text(render(rows_by_platform))
    total = sum(len(v) for v in rows_by_platform.values())
    print(
        f"Wrote {OUTPUT.relative_to(REPO_ROOT)} — {total} row(s) across {len(rows_by_platform)} platform(s)."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
