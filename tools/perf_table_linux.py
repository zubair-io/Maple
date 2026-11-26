"""The Linux part of tools/perf-table.py (#6043): how a row written by
`src/linux/examples/perf-harness` is recorded, checked and rendered.

A Linux row carries the Apple row's cold-open and tick keys for the resident
GPU path, the same keys again under `cpuFallback`, plus profile-switch
cancellation latency, how many ticks were answered, and peak resident
memory. The harness also writes a row when it cannot make a timing claim (software adapter, debug build, wrong host) so the run itself can
be checked; such a row says `timingQualifies: false` and is refused here, as
is any Linux row whose `timingQualifies` is not exactly `true`.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Callable

OPEN_TARGET = "250–1000 ms"
MIN_FRAMES = 20
QUALIFY_TARGET = f"{MIN_FRAMES} frames and half the ticks, to qualify"
UNTRACKED_TARGET = "no fixed target — tracked for regression"

RECORDING_SECTION = [
    "### Linux",
    "",
    "```bash",
    "# Linux — from the repo root on the physical machine, inside the desktop session",
    "# being qualified (Wayland or X11), with nothing else running:",
    "cargo run --locked --release --manifest-path src/linux/Cargo.toml --example perf-harness -- \\",
    "  test-fixtures/raws/dji-mavic3pro-100mp.dng /tmp/maple-linux-perf.json",
    "```",
    "",
    "`perf-harness` (`src/linux/examples/perf-harness/`, #6043) opens a private",
    "copy of the RAW on the application's own preview worker, without a window,",
    "twice: once with the GPU (the resident preview the editor shows) and once",
    "without it (the CPU renderer the application falls back to). For each it",
    "records:",
    "",
    "- **Cold open** — from the open request until the GPU has finished the",
    "  first frame (`coldOpenSubmittedMs` stops at the worker's event, before",
    "  the GPU finished; `coldOpenDecodeMs` is the decode share). The harness",
    "  has just hashed and copied the file, so its bytes are in the OS page",
    "  cache; nothing of the application is warm.",
    "- **Slider ticks** — an Exposure drag and a Contrast drag, one tick every",
    "  1/60 s whether or not the previous frame has arrived, as a real drag",
    "  does. The worker publishes a frame when its GPU commands are submitted,",
    "  not when the GPU has run them, so latency runs from sending a tick until",
    "  the GPU has finished that frame (a work-done callback on the worker's own",
    "  queue); `submittedMs` is the same latency stopped at the worker's event.",
    "  The finished time is an upper bound: the callback also covers a later",
    "  tick's submission if the worker already made one. Every",
    "  tick supersedes the render in flight, so a path slower than 16.7 ms per",
    "  frame answers only some ticks: the row records how many were published",
    "  (`published`, `publishedRatio`) and the longest stretch with no frame at",
    "  all (`worstGapMs`, the delay a user feels). The first published frame of",
    "  each drag is reported apart as `firstTickMs` and kept out of the",
    "  percentiles; the Apple harness reports every tick, so this is stricter.",
    "- **Profile-switch cancellation** — a profile switch, which re-uploads the",
    "  preview, is superseded part-way through by a render for a closed session;",
    "  the latency is the time until the worker has dropped the switch and",
    "  answered. A slider tick superseded by the next tick publishes no event, so",
    "  its cancellation is not timed.",
    "- **Peak resident memory** — the process high-water mark after each path.",
    "  The GPU path runs first, so the CPU fallback's figure includes it. It",
    "  counts host memory only, not GPU memory.",
    "- **Image size** — the decoded RAW's width, height and megapixels as the",
    "  worker reports them (`sensorWidth`, `sensorHeight`, `sensorMegapixels`).",
    "",
    "The row lists what it measures (`coverage`) and what it does not",
    "(`excludes`): the debounced quiet-refine and detail pass, frame",
    "presentation after the worker event, saves on the worker thread, input",
    "dispatch and the egui frame loop, GPU memory, cancellation of a tick",
    "superseded by the next tick, and exact per-frame GPU completion (the",
    "finished-frame time is an upper bound).",
    "",
    "The harness prints whether the row qualifies as a timing measurement. It",
    "qualifies only from a release build with a clean working tree, on a",
    "discrete or integrated hardware Vulkan adapter under Linux, on the",
    "reference RAW (SHA-256 `f4b60b36…a1045aa5`, the hash",
    "`test-fixtures/qualification/browser-100mp-3669.json` records for",
    "`dji-mavic3pro-100mp.dng`), with the GPU path staying resident and each",
    "drag publishing at least 20 frames and half of its ticks. A software",
    "adapter (a CPU rasterizer, as in Linux CI) or any other failed condition",
    "still writes the row, marked `timingQualifies: false` with the reasons,",
    "and `tools/perf-table.py` refuses to render it. The CPU fallback is",
    "recorded for comparison and does not decide qualification.",
    "",
    "Run the harness three times on an idle machine and commit the median run,",
    "ranked by its resident GPU tick p95, to",
    "`test-fixtures/perf/linux/<deviceId>.json` (the harness prints the",
    "`deviceId`); keep the other two logs with the PR's evidence. The Apple",
    "rows keep the better of two runs; Linux commits the median so a lucky run",
    "cannot set the number. Then regenerate and reformat as above.",
    "",
    "No Linux row is committed yet. Linux CI runs the same harness code on a",
    "software adapter, which checks the harness and is not timing evidence; a",
    "row needs a physical Linux machine with a hardware GPU and the reference",
    "RAW, and that measurement is #5970.",
    "",
]


def refuse_unqualified(entry: dict[str, Any], json_path: Path, platform: str) -> None:
    if platform == "linux" and entry.get("timingQualifies") is not True:
        reasons = "; ".join(entry.get("timingDisqualifiers") or ["no reason recorded"])
        raise SystemExit(
            f"{json_path}: this row does not qualify as a timing measurement ({reasons}). "
            "Only rows with timingQualifies true are committed; remove it."
        )


def platform_override(directory: str) -> dict[str, str]:
    """A row in `perf/linux/` is rendered as a Linux row whatever its own
    `platform` says (a smoke run on another host records that host's name)."""
    return {"platform": "linux"} if directory == "linux" else {}


def ms(value: Any) -> str:
    return "—" if value is None else f"{float(value):,.1f} ms"


def count(value: Any) -> str:
    return "—" if value is None else str(int(value))


def megapixels(value: Any) -> str:
    return "— MP" if value is None else f"{float(value):.1f} MP"


def mib(value: Any) -> str:
    return "—" if value is None else f"{float(value) / 2**20:,.0f} MiB"


def hard_limit_row(label: str, tick: dict[str, Any] | None) -> str:
    tick = tick or {}
    return (
        f"| {label} ticks over 50 ms | {count(tick.get('over50'))} of "
        f"{count(tick.get('published'))} published ({count(tick.get('sent'))} sent) | 0 |"
    )


def submitted_row(label: str, tick: dict[str, Any] | None) -> str:
    submitted = (tick or {}).get("submittedMs") or {}
    latency = " / ".join(ms(submitted.get(key)) for key in ("p50Ms", "p95Ms", "maxMs"))
    return (
        f"| {label} tick p50 / p95 / max at worker submission | "
        f"{'—' if submitted.get('p50Ms') is None else latency} | "
        "not a measure of rendered frames: the GPU may not have run them |"
    )


def answered_row(label: str, tick: dict[str, Any] | None, qualifying: bool) -> str:
    tick = tick or {}
    ratio = tick.get("publishedRatio")
    share = "—" if ratio is None else f"{float(ratio):.0%}"
    return (
        f"| {label} frames published | {count(tick.get('published'))} of {count(tick.get('sent'))} "
        f"ticks ({share}); first tick {ms(tick.get('firstTickMs'))}; "
        f"worst gap with no frame {ms(tick.get('worstGapMs'))} | "
        f"{QUALIFY_TARGET if qualifying else UNTRACKED_TARGET} |"
    )


def cancellation_row(label: str, cancellation: dict[str, Any] | None) -> str:
    cancellation = cancellation or {}
    samples = cancellation.get("samples")
    completed = cancellation.get("completedBeforeCancel")
    timed = None if samples is None or completed is None else samples - completed
    latency = (
        "—"
        if cancellation.get("p50Ms") is None
        else " / ".join(ms(cancellation.get(key)) for key in ("p50Ms", "p95Ms", "maxMs"))
    )
    return (
        f"| {label} profile-switch cancellation p50 / p95 / max | {latency} "
        f"({count(timed)} of {count(samples)} profile switches superseded in flight by a "
        f"render for a closed session; the switch takes "
        f"{ms(cancellation.get('switchUninterruptedMs'))} uninterrupted) | "
        f"{UNTRACKED_TARGET} |"
    )


def path_rows(
    label: str,
    path: dict[str, Any],
    tick_rows: Callable[[str, dict[str, Any] | None], list[str]],
) -> list[str]:
    def named(text: str) -> str:
        return f"{label} {text.lower()}" if label else text

    return [
        f"| {named('Cold open, uncached')} | {ms(path.get('coldOpenUncachedMs'))} "
        f"(worker event at {ms(path.get('coldOpenSubmittedMs'))}) | {OPEN_TARGET} |",
        *tick_rows(named("Exposure"), path.get("tickExposure")),
        hard_limit_row(named("Exposure"), path.get("tickExposure")),
        answered_row(named("Exposure"), path.get("tickExposure"), not label),
        submitted_row(named("Exposure"), path.get("tickExposure")),
        *tick_rows(named("Contrast"), path.get("tickContrast")),
        hard_limit_row(named("Contrast"), path.get("tickContrast")),
        answered_row(named("Contrast"), path.get("tickContrast"), not label),
        submitted_row(named("Contrast"), path.get("tickContrast")),
        cancellation_row(label or "Resident GPU", path.get("profileSwitchCancellation")),
    ]


def render_section(
    row: dict[str, Any],
    tick_rows: Callable[[str, dict[str, Any] | None], list[str]],
) -> str:
    """`tick_rows` is perf-table.py's own tick formatter, so the tick lines
    and their 16 ms / 50 ms targets read the same on every platform."""
    cpu = row.get("cpuFallback") or {}
    commit = str(row.get("commitSha", "unknown"))
    source = row.get("_sourceFile", "unknown")
    lines = [
        f"### {row.get('deviceModel', 'unknown device')} — {row.get('fixture', 'unknown')} — "
        f"{row.get('profile', 'unknown')}",
        "",
        (
            f"Chip **{row.get('chip', 'unknown')}** · GPU **{row.get('gpu', 'unknown')}** "
            f"({row.get('gpuBackend', 'unknown')}, {row.get('gpuDeviceType', 'unknown')}, "
            f"driver {row.get('gpuDriver') or 'not reported'}) · {row.get('osVersion', 'unknown')} · "
            f"{row.get('sessionType', 'unknown')} session. Ticks paced at "
            f"{count(row.get('tickRateHz'))} Hz, {count(row.get('ticksPerSlider'))} per slider. "
            f"Preview {count(row.get('viewportWidth'))}×{count(row.get('viewportHeight'))} px. "
            f"Fixture SHA-256 `{row.get('fixtureSha256', 'unknown')}`, decoded "
            f"{count(row.get('sensorWidth'))}×{count(row.get('sensorHeight'))} px "
            f"({megapixels(row.get('sensorMegapixels'))}). "
            f"Cache methodology: `{row.get('cacheState', 'unknown')}`. "
            f"Harness `{row.get('harness', 'unknown')}` at commit `{commit[:12]}`, recorded "
            f"{row.get('date', 'unknown')}. Source row: [`{source}`](../{source})."
        ),
        "",
        "| Measurement | This device | Spec target |",
        "| --- | --- | --- |",
        *path_rows("", row, tick_rows),
        *path_rows("CPU fallback", cpu, tick_rows),
        (
            "| Peak resident memory, after the GPU path / after the CPU fallback | "
            f"{mib(row.get('peakResidentBytes'))} / {mib(cpu.get('peakResidentBytes'))} | "
            f"{UNTRACKED_TARGET} |"
        ),
    ]
    return "\n".join(lines)
