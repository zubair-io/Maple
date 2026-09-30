"""Probe cached MobileSAM refinement and prompt satisfaction locally (#3941)."""

import argparse
import importlib
import json
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch
from PIL import Image

from export_mobile_sam import DIGESTS, REVISION, PhotographicEncoder, load_model, sha256


def session(path, provider):
    manifest = json.loads(path.with_suffix(".json").read_text())
    if (
        manifest["source_revision"] != REVISION
        or manifest["source_digests"] != DIGESTS
        or manifest["artifact_sha256"] != sha256(path)
    ):
        raise ValueError("MobileSAM export provenance mismatch")
    if provider not in ort.get_available_providers():
        raise ValueError(f"Unavailable provider: {provider}")
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    options.inter_op_num_threads = 1
    providers = [provider]
    if provider != "CPUExecutionProvider":
        providers.append("CPUExecutionProvider")
    return ort.InferenceSession(str(path), sess_options=options, providers=providers)


def prompt_checks(mask, points, labels):
    return [
        {
            "label": int(label),
            "selected": bool(mask[int(point[1]), int(point[0])]),
            "satisfied": bool(mask[int(point[1]), int(point[0])]) == bool(label == 1),
        }
        for point, label in zip(points, labels, strict=True)
        if label in (0, 1)
    ]


def probe(source, artifacts, image_path, query_path, output, provider):
    torch.set_num_threads(4)
    model = load_model(source)
    encoder_reference = PhotographicEncoder(model).eval()
    decoder_reference = (
        importlib.import_module("mobile_sam.utils.onnx")
        .SamOnnxModel(model, return_single_mask=False)
        .eval()
    )
    with Image.open(image_path) as image:
        if image.size != (1024, 1024):
            raise ValueError("Expected native photographic 1024 context")
        rgb = (
            np.asarray(image.convert("RGB")).transpose(2, 0, 1)[None].astype(np.float32)
        )
    queries = json.loads(query_path.read_text())
    if not queries:
        raise ValueError("No prompts")
    encoder = session(artifacts / "mobile-sam-encoder.onnx", provider)
    decoder = session(artifacts / "mobile-sam-decoder.onnx", provider)
    start = time.perf_counter()
    embeddings = encoder.run(None, {"image": rgb})[0]
    encoder_ms = (time.perf_counter() - start) * 1000
    if embeddings.shape != (1, 256, 64, 64) or not np.isfinite(embeddings).all():
        raise ValueError("Invalid image embedding")
    with torch.inference_mode():
        expected_embedding = encoder_reference(torch.from_numpy(rgb))
    embedding_error = float(np.abs(embeddings - expected_embedding.numpy()).max())
    output.mkdir(parents=True, exist_ok=True)
    cases = []
    for index, query in enumerate(queries):
        points = np.asarray(query["points"], dtype=np.float32)
        labels = np.asarray(query["labels"], dtype=np.float32)
        if points.shape != (len(labels), 2) or not 1 <= len(labels) <= 64:
            raise ValueError("Expected one through 64 XY/label prompts")
        if (
            not np.isfinite(points).all()
            or not np.isin(labels, [0, 1, 2, 3]).all()
            or (points < 0).any()
            or (points >= 1024).any()
        ):
            raise ValueError("Invalid source prompt")
        if not (labels == 1).any() and not np.isin(labels, [2, 3]).all():
            raise ValueError(
                "Negative-only refinement needs an existing positive selection"
            )
        # Match upstream ONNX contract: pad point-only queries with a not-a-point.
        if not np.isin(labels, [2, 3]).any():
            points = np.concatenate([points, np.zeros((1, 2), dtype=np.float32)])
            labels = np.concatenate([labels, np.array([-1], dtype=np.float32)])
        feeds = {
            "image_embeddings": embeddings,
            "point_coords": points[None],
            "point_labels": labels[None],
            "mask_input": np.zeros((1, 1, 256, 256), dtype=np.float32),
            "has_mask_input": np.zeros(1, dtype=np.float32),
            "orig_im_size": np.array([1024, 1024], dtype=np.float32),
        }
        elapsed = []
        for _ in range(10):
            start = time.perf_counter()
            masks, scores, low = decoder.run(None, feeds)
            elapsed.append((time.perf_counter() - start) * 1000)
        if masks.shape != (1, 4, 1024, 1024) or scores.shape != (1, 4):
            raise ValueError("Decoder shape mismatch")
        if not all(np.isfinite(values).all() for values in (masks, scores, low)):
            raise ValueError("Non-finite decoder result")
        with torch.inference_mode():
            expected_masks, expected_scores, _ = decoder_reference(
                expected_embedding,
                *[torch.from_numpy(value) for value in list(feeds.values())[1:]],
            )
        masks.astype("<f4").tofile(output / f"logits-{index}.f32")
        (output / f"scores-{index}.json").write_text(
            json.dumps(scores[0].tolist()) + "\n"
        )
        binary = masks[0] > 0
        checks = [prompt_checks(mask, points, labels) for mask in binary]
        # No candidate that violates painted point intent may replace a selection.
        valid = [i for i in range(4) if all(c["satisfied"] for c in checks[i])]
        choice = max(valid, key=lambda i: scores[0, i]) if valid else None
        reference = expected_masks.numpy()[0] > 0
        union = np.count_nonzero(binary | reference, axis=(1, 2))
        overlap = np.count_nonzero(binary & reference, axis=(1, 2))
        ious = np.divide(overlap, union, out=np.ones(4), where=union > 0)
        if choice is not None:
            Image.fromarray(binary[choice].astype(np.uint8) * 255).save(
                output / f"mask-{index}.png"
            )
        cases.append(
            {
                "query": query,
                "choice": choice,
                "prompts_satisfied": choice is not None,
                "candidate_prompt_checks": checks,
                "candidate_scores": scores[0].tolist(),
                "candidate_pixels": binary.sum(axis=(1, 2)).tolist(),
                "mask_iou_vs_torch": ious.tolist(),
                "execution_parity_passed": bool(ious.min() >= 0.999),
                "max_logit_error_vs_torch": float(
                    np.abs(masks - expected_masks.numpy()).max()
                ),
                "max_score_error_vs_torch": float(
                    np.abs(scores - expected_scores.numpy()).max()
                ),
                "decoder_elapsed_ms": elapsed,
                "decoder_warm_p95_ms": float(np.percentile(elapsed[1:], 95)),
            }
        )
    report = {
        "source_revision": REVISION,
        "source_digests": DIGESTS,
        "artifact_digests": {
            name: sha256(artifacts / f"mobile-sam-{name}.onnx")
            for name in ("encoder", "decoder")
        },
        "onnxruntime": ort.__version__,
        "provider": provider,
        "image_sha256": sha256(image_path),
        "encoder_elapsed_ms": encoder_ms,
        "max_embedding_error_vs_torch": embedding_error,
        "cases": cases,
        "release_qualified": False,
        "qualification": "Prompt satisfaction and execution parity probe only; photographic boundary quality, browser and physical-device gates remain",
    }
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    if not all(case["execution_parity_passed"] for case in cases):
        raise ValueError(
            "Binary mask parity failed; diagnostic report saved, provider is unqualified"
        )
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("source", "artifacts", "image_path", "query_path", "output"):
        parser.add_argument(name, type=Path)
    parser.add_argument("--provider", default="CPUExecutionProvider")
    print(json.dumps(probe(**vars(parser.parse_args())), indent=2))


if __name__ == "__main__":
    main()
