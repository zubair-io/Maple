"""Coherent-source ghosting measurements for panorama seam comparisons (#3243).

A moving subject may legitimately come from either capture. A panorama that
mixes their positions, cuts the subject in half, or blurs it is not equivalent
to either complete capture. Compare each fixed, complete subject ROI with every
aligned source crop that covers it, then choose ONE source for the whole ROI.
Never choose a source per pixel: that would give a doubled subject zero error.

Colour, signed-gradient residuals and one-sided source-detail loss are reported
against that same source. Missing source edges are charged independently; removing
extra ghost edges cannot cancel the cost of blurring legitimate source texture.
Neither candidate-only edge energy nor independent per-metric source selection
is used. Default promotion requires both residuals to improve, no degradation in
source-detail retention, and the existing coverage/RMSE gates.

Evidence JSON (version 1) supplies the full candidate canvas size and fixed ROI
rectangles [x, y, width, height]. Each ROI has a unique name, a subject description,
and at least two sources with unique names and paths to aligned RGBA crop PNGs. Paths
are relative to the manifest. Each crop must have the exact ROI dimensions and
the same pixel encoding as the candidate and fully opaque alpha proving complete
coverage. Sources must be warped with the SAME
camera solution, gains and local correction as the candidates, before blending.
ROIs cover the union of subject positions and are frozen before comparing seam
strategies. Source disagreement is reported; it is not a semantic motion detector.

This is a local seam diagnostic, not a replacement for whole-image quality or
coverage gates. A scene with no fully covering coherent source cannot be measured
by this metric. Invalid, static, missing, or mismatched evidence fails closed.
PNG decoding follows pano_metrics.py: RGB normalized to 8-bit [0, 1], without a
colour transform or image resizing. Keep unquantized artifacts for deeper work.
"""

import json
from pathlib import Path

import numpy as np
from PIL import Image


def _source_rgb(path):
    with Image.open(path) as image:
        if "A" not in image.getbands() or image.getchannel("A").getextrema() != (
            255,
            255,
        ):
            raise ValueError("source ROI must carry fully opaque coverage alpha")
        return np.asarray(image.convert("RGB"), dtype=np.float64) / 255.0


def _mse(values):
    return float(np.mean(np.square(values)))


def _gradient_mse(delta):
    # Forward differences retain edge direction and position. Comparing only
    # gradient magnitudes could confuse opposite or shifted subject edges.
    return (_mse(np.diff(delta, axis=0)) + _mse(np.diff(delta, axis=1))) / 2.0


def _detail_loss_mse(candidate, source):
    return (
        sum(
            _mse(
                np.maximum(
                    abs(np.diff(source, axis=axis))
                    - abs(np.diff(candidate, axis=axis)),
                    0.0,
                )
            )
            for axis in (0, 1)
        )
        / 2.0
    )


def coherent_residual(candidate, sources):
    """Measure one complete ROI; sources maps stable source names to RGB arrays."""
    if candidate.ndim != 3 or candidate.shape[2] != 3:
        raise ValueError("candidate ROI must be H x W x 3 RGB")
    if min(candidate.shape[:2]) < 2 or not np.isfinite(candidate).all():
        raise ValueError("candidate ROI must be finite and at least 2 x 2")
    if len(sources) < 2:
        raise ValueError("a motion ROI needs at least two coherent sources")

    comparisons = []
    ordered = sorted(sources.items())
    for name, source in ordered:
        if source.shape != candidate.shape or not np.isfinite(source).all():
            raise ValueError(
                f"source {name} has invalid pixels or different dimensions"
            )
        delta = candidate - source
        photo_mse, gradient_mse = _mse(delta), _gradient_mse(delta)
        comparisons.append((photo_mse + gradient_mse, name, photo_mse, gradient_mse))

    disagreement = max(
        _mse(left - right)
        for index, (_, left) in enumerate(ordered)
        for _, right in ordered[index + 1 :]
    )
    if disagreement <= 0:
        raise ValueError("identical source crops provide no motion evidence")

    _, name, photo_mse, gradient_mse = min(comparisons)
    return {
        "source": name,
        "photo_rmse": photo_mse**0.5,
        "gradient_rmse": gradient_mse**0.5,
        "detail_loss_rmse": _detail_loss_mse(candidate, sources[name]) ** 0.5,
        "source_disagreement_rmse": disagreement**0.5,
        "pixels": int(candidate.shape[0] * candidate.shape[1]),
    }


def measure(candidate_path, evidence_path):
    """Read real candidate/evidence PNGs and return the auditable ROI measurements."""
    path = Path(evidence_path)
    evidence = json.loads(path.read_text())
    if evidence.get("version") != 1:
        raise ValueError("unsupported ghost evidence version")
    with Image.open(candidate_path) as candidate:
        return _measure_candidate(candidate, evidence, path.parent)


def _measure_candidate(candidate, evidence, directory):
    width, height = candidate.size
    if evidence.get("canvas_size") != [width, height]:
        raise ValueError("ghost evidence canvas does not match the candidate")
    rois = evidence.get("rois")
    if not isinstance(rois, list) or not rois:
        raise ValueError("ghost evidence has no fixed ROIs")

    results = []
    names = set()
    for roi in rois:
        name = roi.get("name")
        if not isinstance(name, str) or not name or name in names:
            raise ValueError("ROI names must be nonempty and unique")
        names.add(name)
        if not isinstance(roi.get("subject"), str) or not roi["subject"].strip():
            raise ValueError(f"ROI {name} needs a subject description")
        rect = roi.get("rect")
        if (
            not isinstance(rect, list)
            or len(rect) != 4
            or any(type(value) is not int for value in rect)
        ):
            raise ValueError(f"ROI {name} needs an integer [x, y, width, height]")
        x, y, w, h = rect
        if x < 0 or y < 0 or w < 2 or h < 2 or x + w > width or y + h > height:
            raise ValueError(f"ROI {name} is outside the candidate or too small")
        sources = {}
        for source in roi.get("sources", []):
            source_name = source.get("name")
            if (
                not isinstance(source_name, str)
                or not source_name
                or source_name in sources
            ):
                raise ValueError(f"ROI {name} source names must be nonempty and unique")
            sources[source_name] = _source_rgb(directory / source["path"])
        # Decode only each ROI to floating point; a 256MP candidate would otherwise
        # allocate over 6 GB merely to score a handful of small subject regions.
        roi_rgb = (
            np.asarray(
                candidate.crop((x, y, x + w, y + h)).convert("RGB"), dtype=np.float64
            )
            / 255.0
        )
        result = coherent_residual(roi_rgb, sources)
        results.append(
            {"name": name, "subject": roi["subject"], "rect": rect, **result}
        )

    pixels = sum(result["pixels"] for result in results)
    return {
        "version": 1,
        "photo_rmse": (
            sum(result["photo_rmse"] ** 2 * result["pixels"] for result in results)
            / pixels
        )
        ** 0.5,
        "gradient_rmse": (
            sum(result["gradient_rmse"] ** 2 * result["pixels"] for result in results)
            / pixels
        )
        ** 0.5,
        "detail_loss_rmse": (
            sum(
                result["detail_loss_rmse"] ** 2 * result["pixels"] for result in results
            )
            / pixels
        )
        ** 0.5,
        "roi_count": len(results),
        "roi_pixels": pixels,
        "rois": results,
    }
