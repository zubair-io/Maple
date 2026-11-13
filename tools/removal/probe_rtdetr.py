"""Probe portable local person detection on real photographic fixtures (#3941)."""

import argparse
import json
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch
from PIL import Image, ImageDraw

from export_rtdetr import CHECKPOINT, DIGESTS, REVISION, load_model, sha256


def box_iou(a, b):
    corner = np.maximum(a[:2], b[:2])
    end = np.minimum(a[2:], b[2:])
    intersection = float(np.maximum(0, end - corner).prod())
    area_a = float(np.maximum(0, a[2:] - a[:2]).prod())
    area_b = float(np.maximum(0, b[2:] - b[:2]).prod())
    union = area_a + area_b - intersection
    return intersection / union if union else 0.0


def probe(source, checkpoint, artifact, image_path, output, provider):
    manifest = json.loads(artifact.with_suffix(".json").read_text())
    if (
        manifest["source_revision"] != REVISION
        or manifest["source_digests"] != DIGESTS
        or manifest["checkpoint_sha256"] != CHECKPOINT
        or manifest["artifact_sha256"] != sha256(artifact)
    ):
        raise ValueError("RT-DETR artifact provenance mismatch")
    torch.set_num_threads(4)
    model = load_model(source, checkpoint)
    if provider not in ort.get_available_providers():
        raise ValueError(f"Unavailable provider: {provider}")
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    options.inter_op_num_threads = 1
    providers = [provider]
    if provider != "CPUExecutionProvider":
        providers.append("CPUExecutionProvider")
    session = ort.InferenceSession(
        str(artifact), sess_options=options, providers=providers
    )
    with Image.open(image_path) as original:
        image = original.convert("RGB")
    # Matches upstream inference: square resize is a semantic proxy only.
    rgb = np.asarray(image.resize((640, 640), Image.Resampling.BILINEAR))
    data = rgb.transpose(2, 0, 1)[None].astype(np.float32) / 255
    size = np.array([[image.width, image.height]], dtype=np.int64)
    elapsed = []
    for _ in range(6):
        start = time.perf_counter()
        labels, boxes, scores = session.run(
            None, {"images": data, "orig_target_sizes": size}
        )
        elapsed.append((time.perf_counter() - start) * 1000)
    if (
        labels.shape != (1, 300)
        or boxes.shape != (1, 300, 4)
        or scores.shape != (1, 300)
    ):
        raise ValueError("Detector shape mismatch")
    if (
        not np.isfinite(boxes).all()
        or not np.isfinite(scores).all()
        or not np.isin(labels, np.arange(80)).all()
        or (scores < 0).any()
        or (scores > 1).any()
    ):
        raise ValueError("Invalid detector output")
    with torch.inference_mode():
        reference = [
            v.numpy() for v in model(torch.from_numpy(data), torch.from_numpy(size))
        ]
    # Match confident detections by class and overlap; equal-score top-k ties
    # among irrelevant tiny scores may reorder and are not geometric failures.
    parity = []
    for index in np.flatnonzero(scores[0] >= 0.25):
        same = np.flatnonzero(reference[0][0] == labels[0, index])
        match = max(same, key=lambda i: box_iou(boxes[0, index], reference[1][0, i]))
        parity.append(
            {
                "index": int(index),
                "class": int(labels[0, index]),
                "iou_vs_torch": box_iou(boxes[0, index], reference[1][0, match]),
                "score_error_vs_torch": abs(
                    float(scores[0, index] - reference[2][0, match])
                ),
            }
        )
    people = [
        {
            "box": boxes[0, index].tolist(),
            "score": float(scores[0, index]),
            "label": 0,
        }
        for index in range(300)
        if labels[0, index] == 0 and scores[0, index] >= 0.5
    ]
    draw = ImageDraw.Draw(image)
    for person in people:
        draw.rectangle(person["box"], outline="red", width=3)
    output.mkdir(parents=True, exist_ok=True)
    image.save(output / "people.png")
    data.astype("<f4").tofile(output / "input.f32")
    (output / "input.json").write_text(
        json.dumps(
            {
                "size": [image.width, image.height],
                "image_sha256": sha256(image_path),
                "input_sha256": sha256(output / "input.f32"),
            }
        )
        + "\n"
    )
    report = {
        "source_revision": REVISION,
        "artifact_sha256": sha256(artifact),
        "image_sha256": sha256(image_path),
        "source_size": [image.width, image.height],
        "onnxruntime": ort.__version__,
        "provider": provider,
        "elapsed_ms": elapsed,
        "warm_p95_ms": float(np.percentile(elapsed[1:], 95)),
        "people_at_diagnostic_threshold": people,
        "parity": parity,
        "all_labels": labels[0].tolist(),
        "all_boxes": boxes[0].tolist(),
        "all_scores": scores[0].tolist(),
        "execution_parity_passed": all(
            p["iou_vs_torch"] >= 0.999 and p["score_error_vs_torch"] <= 1e-4
            for p in parity
        ),
        "release_qualified": False,
        "qualification": "Execution and geometry diagnostic; thresholds are not release policy, crowds/occlusion recall, subject protection, browser and physical devices remain",
    }
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    if not report["execution_parity_passed"]:
        raise ValueError("Detector parity failed; diagnostic report saved")
    return {k: v for k, v in report.items() if not k.startswith("all_")}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("source", "checkpoint", "artifact", "image_path", "output"):
        parser.add_argument(name, type=Path)
    parser.add_argument("--provider", default="CPUExecutionProvider")
    print(json.dumps(probe(**vars(parser.parse_args())), indent=2))


if __name__ == "__main__":
    main()
