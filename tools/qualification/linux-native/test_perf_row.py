"""`tools/perf-table.py` on the row `src/linux/examples/perf-harness` writes (#6043).

The rows below are invented for these tests, with keys mirroring the harness's
`record.rs`; `src/linux/tests/perf_harness.rs` pins the same key set on a real run.
"""

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(TOOLS))
SPEC = importlib.util.spec_from_file_location("perf_table", TOOLS / "perf-table.py")
perf_table = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(perf_table)


def ticks(p50, p95, maximum, over16, over50, published, sent=120):
    return {
        "firstTickMs": p50 * 3,
        "publishedRatio": published / sent,
        "worstGapMs": maximum * 2,
        "p50Ms": p50,
        "p95Ms": p95,
        "maxMs": maximum,
        "over16": over16,
        "over50": over50,
        "published": published,
        "sent": sent,
    }


def path(cold_open, exposure, contrast, cancellation, peak, renderer):
    return {
        "renderer": renderer,
        "profile": "auto",
        "viewportWidth": 1600,
        "viewportHeight": 1200,
        "coldOpenUncachedMs": cold_open,
        "coldOpenDecodeMs": cold_open / 2,
        "tickExposure": exposure,
        "tickContrast": contrast,
        "profileSwitchCancellation": cancellation,
        "peakResidentBytes": peak,
    }


def row(**overrides):
    base = {
        "platform": "linux",
        "harness": "perf-harness",
        "commitSha": "0123456789abcdef0123456789abcdef01234567",
        "date": "2026-11-26T12:00:00Z",
        "deviceId": "Example-Workstation-Example-GPU",
        "deviceModel": "Example Workstation",
        "chip": "Example CPU",
        "osVersion": "Example Linux 1.0",
        "sessionType": "wayland",
        "gpu": "Example GPU",
        "gpuDriver": "example 1.2.3",
        "gpuBackend": "Vulkan",
        "gpuDeviceType": "DiscreteGpu",
        "softwareAdapter": False,
        "buildProfile": "release",
        "timingQualifies": True,
        "timingDisqualifiers": [],
        "fixture": "reference.dng",
        "fixtureSha256": "ab" * 32,
        "sensorWidth": 12288,
        "sensorHeight": 8192,
        "sensorMegapixels": 100.663296,
        "cacheState": "uncachedOpen",
        "tickRateHz": 60,
        "ticksPerSlider": 120,
        **path(
            900.0,
            ticks(5.0, 9.0, 12.5, 0, 0, 120),
            ticks(6.0, 17.5, 51.0, 2, 1, 118),
            {
                "switchUninterruptedMs": 400.0,
                "samples": 5,
                "completedBeforeCancel": 1,
                "p50Ms": 20.0,
                "p95Ms": 35.0,
                "maxMs": 35.0,
            },
            3 * 2**30,
            "gpu-resident",
        ),
        "cpuFallback": path(
            2400.0,
            ticks(700.0, 800.0, 810.0, 3, 3, 3),
            ticks(710.0, 790.0, 790.0, 4, 4, 4),
            {"switchUninterruptedMs": 750.0, "samples": 5, "completedBeforeCancel": 5},
            5 * 2**30,
            "cpu",
        ),
    }
    return {**base, **overrides}


class LinuxSectionTest(unittest.TestCase):
    def test_section_reports_both_render_paths_answered_ticks_cancellation_and_memory(self) -> None:
        section = perf_table.render_row_section({**row(), "_sourceFile": "perf/linux/x.json"})
        for expected in (
            "### Example Workstation — reference.dng — auto",
            "GPU **Example GPU** (Vulkan, DiscreteGpu, driver example 1.2.3)",
            "wayland session. Ticks paced at 60 Hz, 120 per slider. Preview 1600×1200 px.",
            f"Fixture SHA-256 `{'ab' * 32}`, decoded 12288×8192 px (100.7 MP).",
            "| Contrast frames published | 118 of 120 ticks (98%); first tick 18.0 ms; "
            "worst gap with no frame 102.0 ms | 20 frames and half the ticks, to qualify |",
            "commit `0123456789ab`",
            "[`perf/linux/x.json`](../perf/linux/x.json)",
            "| Cold open, uncached | 900.0 ms | 250–1000 ms |",
            "| Exposure tick p50 / p95 / max | 5.0 ms / 9.0 ms / 12.5 ms | 16 ms / 50 ms (hard) |",
            "| Contrast ticks over 16 ms | 2 of 118 published | 0 |",
            "| Contrast ticks over 50 ms | 1 of 118 published (120 sent) | 0 |",
            "| Resident GPU profile-switch cancellation p50 / p95 / max | 20.0 ms / 35.0 ms / 35.0 ms "
            "(4 of 5 profile switches superseded in flight by a render for a closed session; "
            "the switch takes 400.0 ms uninterrupted) |",
            "| CPU fallback contrast frames published | 4 of 120 ticks (3%); first tick 2,130.0 ms; "
            "worst gap with no frame 1,580.0 ms | no fixed target — tracked for regression |",
            "| CPU fallback cold open, uncached | 2,400.0 ms | 250–1000 ms |",
            "| CPU fallback exposure tick p50 / p95 / max | 700.0 ms / 800.0 ms / 810.0 ms |",
            "| CPU fallback contrast ticks over 50 ms | 4 of 4 published (120 sent) | 0 |",
            "| CPU fallback profile-switch cancellation p50 / p95 / max | — "
            "(0 of 5 profile switches superseded in flight by a render for a closed session; "
            "the switch takes 750.0 ms uninterrupted) |",
            "| Peak resident memory, after the GPU path / after the CPU fallback | 3,072 MiB / 5,120 MiB |",
        ):
            self.assertIn(expected, section)

    def test_a_row_missing_its_measurements_renders_dashes_not_numbers(self) -> None:
        section = perf_table.render_row_section({"platform": "linux", "fixture": "reference.dng"})
        self.assertIn("| Cold open, uncached | — | 250–1000 ms |", section)
        self.assertIn("| Exposure ticks over 50 ms | — of — published (— sent) | 0 |", section)
        self.assertIn("| CPU fallback profile-switch cancellation p50 / p95 / max | — (— of — profile", section)
        self.assertIn("| — / — | no fixed target", section)
        self.assertIn("decoded —×— px (— MP)", section)


class CommittedRowsTest(unittest.TestCase):
    def load(self, entry: dict):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            target = root / "perf" / "linux" / "Example-Workstation-Example-GPU.json"
            target.parent.mkdir(parents=True)
            target.write_text(json.dumps([entry]))
            original = perf_table.REPO_ROOT, perf_table.PERF_DIR
            perf_table.REPO_ROOT, perf_table.PERF_DIR = root, root / "perf"
            try:
                return perf_table.render(perf_table.load_rows())
            finally:
                perf_table.REPO_ROOT, perf_table.PERF_DIR = original

    def test_a_qualifying_row_renders_under_the_linux_heading(self) -> None:
        document = self.load(row())
        self.assertIn("## Linux\n\n### Example Workstation — reference.dng — auto", document)
        self.assertIn("perf/linux/Example-Workstation-Example-GPU.json", document)

    def test_a_row_in_the_linux_folder_renders_as_a_linux_row_whatever_its_platform_says(self) -> None:
        document = self.load(row(platform="macos"))
        self.assertIn("frames published", document)

    def test_a_software_adapter_row_is_refused_not_rendered(self) -> None:
        software = row(
            softwareAdapter=True,
            timingQualifies=False,
            timingDisqualifiers=["software adapter: a CPU rasterizer is not GPU evidence"],
        )
        with self.assertRaises(SystemExit) as refusal:
            self.load(software)
        self.assertIn("does not qualify as a timing measurement", str(refusal.exception))
        self.assertIn("software adapter", str(refusal.exception))

    def test_a_linux_row_renders_only_when_it_says_it_qualifies(self) -> None:
        missing = row()
        del missing["timingQualifies"]
        for flag in ("missing", None, "true", 1, False):
            entry = missing if flag == "missing" else row(timingQualifies=flag)
            with self.subTest(timingQualifies=flag):
                with self.assertRaises(SystemExit) as refusal:
                    self.load(entry)
                self.assertIn("does not qualify as a timing measurement", str(refusal.exception))

    def test_the_committed_rows_all_qualify(self) -> None:
        self.assertIn("## macOS", perf_table.render(perf_table.load_rows()))


if __name__ == "__main__":
    unittest.main()
