"""Tests for compare_images.diff(). Run: python3 src/scripts/compare_images_test.py

Synthetic-image checks:
  * return-key stability (the harness depends on these exact keys)
  * identical images -> ~zero deltaE everywhere
  * a localized (red, highlight) shift surfaces in the right zone + hue bin
    and stays ~zero elsewhere (attribution)
  * population-weighted mean of zone means reconstructs the global mean
"""

import json
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, PngImagePlugin

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).parent / "acr-reference"))
import compare_images as ci
from write_xmp import explicit_reference_defaults


def _metadata(exposure="0"):
    metadata = PngImagePlugin.PngInfo()
    metadata.add_itxt(
        "XML:com.adobe.xmp",
        f'<x xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Exposure2012="{exposure}"/>',
    )
    return metadata


def _write(path, arr_u8):
    Image.fromarray(arr_u8, "RGB").save(path, pnginfo=_metadata())


def _checker_highlight_red(h=64, w=64):
    """Neutral mid-grey background (L*~50, MID zone); a bright reddish block
    (L*~77, HIGHLIGHT zone, red/orange hue) in one quadrant. The block color
    is chosen so it lands in the highlight L* band AND carries real chroma —
    a pure bright red (230,40,40) is only L*~50 and would fall in MID."""
    img = np.full((h, w, 3), 120, dtype=np.uint8)  # neutral mid grey
    img[: h // 2, : w // 2] = (250, 170, 160)  # bright reddish (highlight)
    return img


def test_return_keys():
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "a.png"
        _write(p, _checker_highlight_red())
        out = ci.diff(str(p), str(p))
        for k in (
            "mean_deltaE",
            "p95_deltaE",
            "max_deltaE",
            "bias_r",
            "bias_g",
            "bias_b",
            "n_pixels",
        ):
            assert k in out, f"missing key {k}"
        assert out["mean_deltaE"] < 1e-3, out["mean_deltaE"]


def test_attribution():
    with tempfile.TemporaryDirectory() as d:
        ref_p = Path(d) / "ref.png"
        cand_p = Path(d) / "cand.png"
        ref = _checker_highlight_red()
        cand = ref.copy()
        # Perturb ONLY the bright-red block (highlight zone, red hue).
        cand[:32, :32, 0] = 200  # pull red down -> color shift there
        _write(ref_p, ref)
        _write(cand_p, cand)
        out = ci.diff(str(cand_p), str(ref_p), zones=True, hue_bins=12)

        # The grey background (mid zone, neutral hue) must be ~untouched.
        assert out["zones"]["mid"]["mean_deltaE"] < 0.5, out["zones"]["mid"]
        # The highlight zone (where the red block lives) must light up.
        assert out["zones"]["highlight"]["mean_deltaE"] > 3.0, out["zones"]["highlight"]
        # Some chromatic hue bin must carry the error; the neutral bucket must not.
        max_bin = max(
            (b for b in out["hue_bins"]["bins"] if b["n"] > 0),
            key=lambda b: b["mean_deltaE"],
        )
        assert max_bin["mean_deltaE"] > 3.0, max_bin
        assert out["hue_bins"]["neutral"]["mean_deltaE"] < 0.5, out["hue_bins"][
            "neutral"
        ]


def test_zone_self_consistency():
    with tempfile.TemporaryDirectory() as d:
        ref_p = Path(d) / "ref.png"
        cand_p = Path(d) / "cand.png"
        ref = _checker_highlight_red()
        rng = np.random.default_rng(0)
        cand = np.clip(
            ref.astype(np.int16) + rng.integers(-15, 15, ref.shape), 0, 255
        ).astype(np.uint8)
        _write(ref_p, ref)
        _write(cand_p, cand)
        out = ci.diff(str(cand_p), str(ref_p), zones=True)
        zones = [z for z in out["zones"].values() if z.get("n", 0) > 0]
        total = sum(z["n"] for z in zones)
        recon = sum(z["mean_deltaE"] * z["n"] for z in zones) / total
        assert abs(recon - out["mean_deltaE"]) < 1e-3, (recon, out["mean_deltaE"])


def test_matching_reduction_does_not_measure_reference_exporter_filter():
    with tempfile.TemporaryDirectory() as directory:
        full = Path(directory) / "full.png"
        down = Path(directory) / "down.png"
        pixels = np.zeros((96, 128, 3), dtype=np.uint8)
        pixels[:, 43:47] = (255, 180, 60)
        _write(full, pixels)
        with Image.open(full) as image:
            image.resize((37, 28), Image.Resampling.BICUBIC).save(
                down, pnginfo=_metadata()
            )
        outputs = [
            {"resolution": "full", "png": str(full)},
            {"resolution": "down", "png": str(down)},
        ]
        # Identical native scenes should have no color error. Comparing the
        # native candidate to a differently filtered down reference invents one.
        assert ci.diff(str(full), str(down))["max_deltaE"] > 1.0
        matched = ci.diff_manifest_case(
            str(full), outputs, "down", case_label="baseline", zones=True, hue_bins=12
        )
        assert matched["max_deltaE"] == 0.0
        assert matched["n_pixels"] == 37 * 28
        assert (
            ci.diff_manifest_case(
                str(full),
                outputs,
                "down",
                case_label="baseline_auto",
                zones=True,
                hue_bins=12,
            )
            == matched
        )
        assert (
            ci.diff_manifest_case(str(full), outputs, "full", case_label="baseline")[
                "max_deltaE"
            ]
            == 0.0
        )


def test_matching_reduction_requires_the_native_reference():
    with tempfile.TemporaryDirectory() as directory:
        down = Path(directory) / "down.png"
        _write(down, _checker_highlight_red())
        for full_outputs in [
            [],
            [{"resolution": "full", "png": str(Path(directory) / "missing.png")}],
        ]:
            outputs = [{"resolution": "down", "png": str(down)}, *full_outputs]
            try:
                ci.diff_manifest_case(str(down), outputs, "down", case_label="baseline")
            except FileNotFoundError as error:
                assert "native full reference required" in str(error)
            else:
                raise AssertionError(
                    "missing full reference must not fall back to down pixels"
                )


def test_matching_reduction_rejects_invalid_geometry_and_settings():
    with tempfile.TemporaryDirectory() as directory:
        full, down, candidate = (
            Path(directory) / name for name in ("full.png", "down.png", "candidate.png")
        )
        outputs = [
            {"resolution": "full", "png": str(full)},
            {"resolution": "down", "png": str(down)},
        ]
        for native_size, down_size, candidate_size, metadata, expected in [
            ((32, 24), (64, 48), (32, 24), _metadata(), "smaller"),
            ((128, 96), (64, 30), (128, 96), _metadata(), "aspect"),
            ((128, 96), (64, 48), (64, 48), _metadata(), "native reference dimensions"),
            ((128, 96), (64, 48), (128, 96), None, "no Camera Raw XMP"),
            ((128, 96), (64, 48), (128, 96), _metadata("1"), "settings differ"),
        ]:
            Image.new("RGB", native_size).save(full, pnginfo=_metadata())
            Image.new("RGB", down_size).save(down, pnginfo=metadata)
            Image.new("RGB", candidate_size).save(candidate)
            try:
                ci.diff_manifest_case(
                    str(candidate), outputs, "down", case_label="baseline"
                )
            except ValueError as error:
                assert expected in str(error), str(error)
            else:
                raise AssertionError(f"invalid pair accepted: {expected}")


def test_matching_reduction_checks_supplied_adobe_authoring_sidecar():
    with tempfile.TemporaryDirectory() as directory:
        full = Path(directory) / "full.png"
        sidecar = Path(directory) / "reference.xmp"
        _write(full, _checker_highlight_red())
        sidecar.write_text(
            '<x xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Exposure2012="1"/>'
        )
        try:
            ci.diff_manifest_case(
                str(full),
                [{"resolution": "full", "png": str(full)}],
                "full",
                case_label="baseline",
                reference_xmp=str(sidecar),
            )
        except ValueError as error:
            assert "explicitly author" in str(error)
        else:
            raise AssertionError("incomplete authoring sidecar must fail closed")


def test_nonbaseline_down_only_retains_legacy_comparison():
    with tempfile.TemporaryDirectory() as directory:
        down = Path(directory) / "down.png"
        candidate = Path(directory) / "candidate.png"
        Image.fromarray(_checker_highlight_red(), "RGB").save(down)
        Image.fromarray(_checker_highlight_red(), "RGB").resize((128, 128)).save(
            candidate
        )
        outputs = [{"resolution": "down", "png": str(down)}]
        actual = ci.diff_manifest_case(
            str(candidate), outputs, "down", case_label="exposure_max"
        )
        assert actual.pop("reference_protocol") == "legacy-direct-reference"
        assert actual == ci.diff(str(candidate), str(down))
        for label in ("baseline", "baseline_auto"):
            try:
                ci.diff_manifest_case(str(candidate), outputs, "down", case_label=label)
            except FileNotFoundError:
                pass
            else:
                raise AssertionError(f"{label} accepted a down-only reference")


def _qualified_native_pair(directory):
    authored = explicit_reference_defaults(
        b'<x xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" '
        b'xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
        b'<rdf:Description crs:CameraProfile="Adobe Standard" '
        b'crs:WhiteBalance="Custom" crs:Temperature="6500" crs:Tint="150"/></x>'
    )
    metadata = PngImagePlugin.PngInfo()
    metadata.add_itxt("XML:com.adobe.xmp", authored.decode())
    full, down, sidecar = [
        Path(directory) / name for name in ("full.png", "down.png", "reference.xmp")
    ]
    pixels = np.zeros((96, 128, 3), dtype=np.uint8)
    pixels[:, 43:47] = (255, 180, 60)
    Image.fromarray(pixels).save(full, pnginfo=metadata)
    with Image.open(full) as image:
        image.resize((37, 28), Image.Resampling.BICUBIC).save(down, pnginfo=metadata)
    sidecar.write_bytes(authored)
    outputs = [
        {"resolution": "full", "png": str(full)},
        {"resolution": "down", "png": str(down)},
    ]
    return full, down, sidecar, outputs


def test_explicit_nonbaseline_migration_matches_reduction_and_keeps_full_pixels():
    with tempfile.TemporaryDirectory() as directory:
        full, _down, sidecar, outputs = _qualified_native_pair(directory)
        for label in ("exposure_max", "tint_min", "sharpen_detail_max"):
            for resolution, pixels in (("down", 37 * 28), ("full", 128 * 96)):
                result = ci.diff_manifest_case(
                    str(full),
                    outputs,
                    resolution,
                    case_label=label,
                    reference_xmp=str(sidecar),
                    reference_protocol="native-pair-lanczos-v1",
                )
                assert result["reference_protocol"] == "native-pair-lanczos-v1"
                assert result["max_deltaE"] == 0.0
                assert result["n_pixels"] == pixels
        legacy = ci.diff_manifest_case(
            str(full),
            outputs,
            "down",
            case_label="exposure_max",
            reference_xmp=str(sidecar),
        )
        assert legacy["reference_protocol"] == "legacy-direct-reference"
        assert legacy["max_deltaE"] > 1.0


def test_explicit_migration_fails_closed_on_unknown_protocol_or_missing_authoring():
    with tempfile.TemporaryDirectory() as directory:
        full, _down, sidecar, outputs = _qualified_native_pair(directory)
        for options, expected in (
            (
                {"reference_protocol": "native-pair-lanczos"},
                "unknown reference protocol",
            ),
            (
                {"reference_protocol": "native-pair-lanczos-v1"},
                "explicit Adobe authoring",
            ),
        ):
            try:
                ci.diff_manifest_case(
                    str(full), outputs, "down", case_label="tint_max", **options
                )
            except ValueError as error:
                assert expected in str(error)
            else:
                raise AssertionError("invalid migration accepted")
        try:
            ci.diff_manifest_case(
                str(full),
                outputs[1:],
                "down",
                case_label="tint_max",
                reference_xmp=str(sidecar),
                reference_protocol="native-pair-lanczos-v1",
            )
        except FileNotFoundError:
            pass
        else:
            raise AssertionError("migrated case fell back to down pixels")


def test_explicit_migration_rejects_ignored_adobe_tint():
    with tempfile.TemporaryDirectory() as directory:
        full, down, sidecar, outputs = _qualified_native_pair(directory)
        metadata = PngImagePlugin.PngInfo()
        metadata.add_itxt(
            "XML:com.adobe.xmp",
            sidecar.read_text().replace('crs:Tint="150"', 'crs:Tint="10"'),
        )
        with Image.open(down) as image:
            pixels = image.copy()
        pixels.save(down, pnginfo=metadata)
        try:
            ci.diff_manifest_case(
                str(full),
                outputs,
                "down",
                case_label="tint_max",
                reference_xmp=str(sidecar),
                reference_protocol="native-pair-lanczos-v1",
            )
        except ValueError as error:
            assert "Tint" in str(error)
        else:
            raise AssertionError("migrated case accepted Adobe's ignored tint")


def test_chunking_preserves_all_statistics_and_roi():
    from unittest.mock import patch

    import compare_images_chunks as chunks

    def monolithic(candidate, reference, lab, retain_lab):
        a, b = lab(candidate), lab(reference)
        return ci.colour.delta_E(a, b, method="CIE 2000"), a, b

    rng = np.random.default_rng(3875)
    with tempfile.TemporaryDirectory() as d:
        candidate, reference, roi = [
            Path(d) / name for name in ("a.png", "b.png", "roi.png")
        ]
        _write(candidate, rng.integers(0, 256, (23, 31, 3), dtype=np.uint8))
        _write(reference, rng.integers(0, 256, (23, 31, 3), dtype=np.uint8))
        Image.fromarray(
            (np.indices((23, 31)).sum(axis=0) % 3 == 0).astype(np.uint8) * 255
        ).save(roi)
        for primaries in ("srgb", "p3"):
            for mask in (None, str(roi)):
                for detailed in (False, True):
                    options = {
                        "source_primaries": primaries,
                        "roi_path": mask,
                        "zones": detailed,
                        "hue_bins": 8 if detailed else 0,
                    }
                    with patch.object(ci, "perceptual_difference", monolithic):
                        expected = ci.diff(str(candidate), str(reference), **options)
                    # Cross row boundaries and exercise a partial final block.
                    with patch.object(chunks, "BLOCK_PIXELS", 17):
                        actual = ci.diff(str(candidate), str(reference), **options)
                    assert actual == expected, (
                        primaries,
                        mask,
                        detailed,
                        actual,
                        expected,
                    )


def test_bias_is_invariant_under_pixel_repetition():
    """The same signed error must not drift with the image/ROI population."""
    with tempfile.TemporaryDirectory() as directory:
        candidate, reference, roi = [
            Path(directory) / name for name in ("a.png", "b.png", "roi.png")
        ]
        fields = ("bias_r", "bias_g", "bias_b")
        errors = []
        for edge in (1, 512):
            pixels = np.full((edge, edge, 3), (128, 126, 129), dtype=np.uint8)
            _write(candidate, pixels)
            _write(reference, np.full_like(pixels, 127))
            mask = np.full((edge, edge), 255, dtype=np.uint8)
            mask[1::2] = 0
            Image.fromarray(mask).save(roi)
            for masked in (False, True):
                result = ci.diff(
                    str(candidate),
                    str(reference),
                    zones=True,
                    roi_path=str(roi) if masked else None,
                )
                if edge == 1 and not masked:
                    expected = np.array([result[key] for key in fields])
                for label, values in (
                    ("full/ROI", result),
                    ("zone", result["zones"]["mid"]),
                ):
                    actual = np.array([values[key] for key in fields])
                    if not np.allclose(actual, expected, atol=1e-12, rtol=0):
                        errors.append((edge, masked, label, actual, expected))
        assert not errors, errors


def test_bias_preserves_signed_cancellation_and_pixel_order():
    with tempfile.TemporaryDirectory() as directory:
        candidate, reference = [Path(directory) / name for name in ("a.png", "b.png")]
        # Two exact float32 residuals repeated in large spatial blocks. The
        # oracle adds the two unique values, rather than repeating the reduction.
        values = np.array([255, 0, 1, 253], dtype=np.float32) / 255.0
        expected = (float(values[0] - values[2]) + float(values[1] - values[3])) / 2
        a = np.zeros((512, 512, 3), dtype=np.uint8)
        b = np.full_like(a, 253)
        a[:256] = 255
        b[:256] = 1
        for flip in (False, True):
            _write(candidate, a[::-1] if flip else a)
            _write(reference, b[::-1] if flip else b)
            result = ci.diff(str(candidate), str(reference))
            for key in ("bias_r", "bias_g", "bias_b"):
                assert abs(result[key] - expected) < 1e-12, (
                    flip,
                    key,
                    result[key],
                    expected,
                )


def test_swift_calibration_expectations_match_python():
    calibration = (
        Path(__file__).resolve().parents[1] / "apple/MapleUITests/Goldens/.calibration"
    )
    for name in (".", "bias-repetition", "bias-cancellation"):
        directory = calibration / name
        expected = json.loads((directory / "expected.json").read_text())
        actual = ci.diff(str(directory / "a.png"), str(directory / "b.png"))
        assert actual.keys() == expected.keys(), name
        for field, value in expected.items():
            tolerance = 1e-12 if field.startswith("bias_") else 1e-3
            assert abs(actual[field] - value) < tolerance, (
                name,
                field,
                actual,
                expected,
            )


def main():
    import unittest

    import compare_images_metadata_test

    suite = unittest.defaultTestLoader.loadTestsFromModule(compare_images_metadata_test)
    if not unittest.TextTestRunner().run(suite).wasSuccessful():
        raise AssertionError("authoring metadata tests failed")
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok  {name}")
    print("all compare_images tests passed")


if __name__ == "__main__":
    main()
