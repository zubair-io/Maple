"""Compare pinned removal graphs on deployment ORT versions locally (#3941).

Uses already prepared photographic inputs, without importing PyTorch or loading
checkpoints. Desktop CPU execution is not iOS/static, accelerator or UI proof.
"""

import argparse
import hashlib
import json
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image


PINS = {
    pin["id"]: (pin["probe_path"], pin["sha256"])
    for pin in json.loads(
        Path(__file__).with_name("removal-models.generated.json").read_text()
    )
}


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def floats(path, shape, low=None, high=None):
    data = np.fromfile(path, dtype="<f4").reshape(shape)
    if not np.isfinite(data).all():
        raise ValueError(f"Non-finite input: {path}")
    if (low is not None and data.min() < low) or (
        high is not None and data.max() > high
    ):
        raise ValueError(f"Input outside model domain: {path}")
    return data


def run(root, name, feeds, shapes, output, input_pins):
    relative, expected = PINS[name]
    artifact = root / relative
    manifest = json.loads(artifact.with_suffix(".json").read_text())
    if digest(artifact) != expected or manifest["artifact_sha256"] != expected:
        raise ValueError(f"Pinned {name} artifact mismatch")
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    options.inter_op_num_threads = 1
    session = ort.InferenceSession(
        str(artifact), sess_options=options, providers=["CPUExecutionProvider"]
    )
    started = time.perf_counter()
    values = session.run(None, feeds)
    elapsed = (time.perf_counter() - started) * 1000
    if len(values) != len(shapes) or any(
        value.shape != shape or not np.isfinite(value).all()
        for value, shape in zip(values, shapes, strict=True)
    ):
        raise ValueError(f"Invalid {name} output shape/finiteness")
    np.savez(output / f"{name}.npz", *values)
    return values, {
        "artifact_sha256": expected,
        "input_sha256": input_pins,
        "elapsed_ms": elapsed,
        "shapes": [list(value.shape) for value in values],
    }


def iou(a, b):
    area = np.maximum(0, np.minimum(a[2:], b[2:]) - np.maximum(a[:2], b[:2])).prod()
    union = np.maximum(0, a[2:] - a[:2]).prod()
    union += np.maximum(0, b[2:] - b[:2]).prod() - area
    return float(area / union) if union else 0.0


def compare(name, values, reference):
    with np.load(reference / f"{name}.npz", allow_pickle=False) as archive:
        expected = [archive[f"arr_{i}"] for i in range(len(values))]
    if any(a.shape != b.shape for a, b in zip(values, expected, strict=True)):
        raise ValueError(f"Reference {name} shape mismatch")
    if name == "decoder":
        actual_mask, expected_mask = values[0] > 0, expected[0] > 0
        union = (actual_mask | expected_mask).sum(axis=(2, 3))
        overlap = (actual_mask & expected_mask).sum(axis=(2, 3))
        ratios = np.divide(overlap, union, out=np.ones((1, 4)), where=union > 0)
        return {"mask_iou": ratios[0].tolist(), "passed": bool(ratios.min() >= 0.999)}
    if name == "detector":
        matched = []
        for index in np.flatnonzero(values[2][0] >= 0.25):
            candidates = np.flatnonzero(expected[0][0] == values[0][0, index])
            if not len(candidates):
                return {"passed": False, "missing_reference_class": int(index)}
            match = max(
                candidates, key=lambda i: iou(values[1][0, index], expected[1][0, i])
            )
            matched.append(
                {
                    "iou": iou(values[1][0, index], expected[1][0, match]),
                    "score_error": float(
                        abs(values[2][0, index] - expected[2][0, match])
                    ),
                }
            )
        return {
            "matches": matched,
            "passed": bool(matched)
            and all(v["iou"] >= 0.999 and v["score_error"] <= 0.001 for v in matched),
        }
    error = float(np.abs(values[0] - expected[0]).max())
    return {
        "max_float_error": error,
        "passed": error <= 1 / 255 if name == "lama" else None,
    }


def probe(args):
    args.output.mkdir(parents=True, exist_ok=True)
    report = {
        "onnxruntime": ort.__version__,
        "provider": "CPUExecutionProvider",
        "release_qualified": False,
        "qualification": "Desktop runtime-version diagnostic only; physical iOS/static, accelerator, photographic and product gates remain",
        "models": {},
    }
    results = {}
    rgb_path = args.context / "input.f32"
    rgb = floats(rgb_path, (1, 3, 1024, 1024), 0, 1)
    masks_path = args.context / "masks.f32"
    planes = floats(masks_path, (2, 1024, 1024), 0, 1)
    if not np.isin(planes[0], [0, 1]).all() or (planes[1][planes[0] == 0] != 0).any():
        raise ValueError("Expected real shared hole/coverage planes")
    hole = planes[0][None, None]
    results["lama"], report["models"]["lama"] = run(
        args.root,
        "lama",
        {"masked_image_and_mask": np.concatenate([rgb * (1 - hole), hole], axis=1)},
        [(1, 3, 1024, 1024)],
        args.output,
        [digest(rgb_path), digest(masks_path)],
    )
    if results["lama"][0].min() < 0 or results["lama"][0].max() > 1:
        raise ValueError("Reconstruction exceeds recipe domain")
    image_path = args.selection / "input.png"
    with Image.open(image_path) as image:
        if image.size != (1024, 1024):
            raise ValueError("Selection requires prepared 1024 context")
        photographic = (
            np.asarray(image.convert("RGB")).transpose(2, 0, 1)[None].astype(np.float32)
        )
    results["encoder"], report["models"]["encoder"] = run(
        args.root,
        "encoder",
        {"image": photographic},
        [(1, 256, 64, 64)],
        args.output,
        [digest(image_path)],
    )
    query_path = args.selection / "queries.json"
    queries = json.loads(query_path.read_text())
    if len(queries) != 1:
        raise ValueError("This compatibility case requires one prepared query")
    points = np.asarray(queries[0]["points"], dtype=np.float32)
    labels = np.asarray(queries[0]["labels"], dtype=np.float32)
    if (
        points.shape != (len(labels), 2)
        or not 1 <= len(labels) <= 64
        or not np.isfinite(points).all()
        or (points < 0).any()
        or (points >= 1024).any()
        or not np.isin(labels, [0, 1, 2, 3]).all()
    ):
        raise ValueError("Invalid prepared SAM prompts")
    boxes = np.isin(labels, [2, 3]).any()
    if boxes and (
        np.count_nonzero(labels == 2) != 1 or np.count_nonzero(labels == 3) != 1
    ):
        raise ValueError("Box requires exactly one corner pair")
    if not boxes:
        if not (labels == 1).any():
            raise ValueError("Point query requires positive intent")
        points = np.concatenate([points, np.zeros((1, 2), dtype=np.float32)])
        labels = np.concatenate([labels, np.array([-1], dtype=np.float32)])
    results["decoder"], report["models"]["decoder"] = run(
        args.root,
        "decoder",
        {
            "image_embeddings": results["encoder"][0],
            "point_coords": points[None],
            "point_labels": labels[None],
            "mask_input": np.zeros((1, 1, 256, 256), dtype=np.float32),
            "has_mask_input": np.zeros(1, dtype=np.float32),
            "orig_im_size": np.array([1024, 1024], dtype=np.float32),
        },
        [(1, 4, 1024, 1024), (1, 4), (1, 4, 256, 256)],
        args.output,
        [digest(image_path), digest(query_path)],
    )
    detection_path = args.detection / "input.f32"
    metadata = json.loads((args.detection / "input.json").read_text())
    if metadata["input_sha256"] != digest(detection_path):
        raise ValueError("Prepared detector input checksum mismatch")
    results["detector"], report["models"]["detector"] = run(
        args.root,
        "detector",
        {
            "images": floats(detection_path, (1, 3, 640, 640), 0, 1),
            "orig_target_sizes": np.asarray([metadata["size"]], dtype=np.int64),
        },
        [(1, 300), (1, 300, 4), (1, 300)],
        args.output,
        [digest(detection_path)],
    )
    if args.reference:
        prior = json.loads((args.reference / "report.json").read_text())
        for name, values in results.items():
            entry = report["models"][name]
            if entry["input_sha256"] != prior["models"][name]["input_sha256"]:
                raise ValueError(f"Reference {name} input mismatch")
            entry["comparison"] = compare(name, values, args.reference)
        report["reference_runtime"] = prior["onnxruntime"]
    (args.output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    if any(
        v.get("comparison", {}).get("passed") is False
        for v in report["models"].values()
    ):
        raise ValueError("Runtime execution parity failed; diagnostic report saved")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("root", "context", "selection", "detection", "output"):
        parser.add_argument(name, type=Path)
    parser.add_argument("--reference", type=Path)
    print(json.dumps(probe(parser.parse_args()), indent=2))
