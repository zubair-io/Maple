"""Qualify pinned EfficientSAM encoder/decoder execution locally (#3941)."""

import argparse
import hashlib
import importlib
import json
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch
from PIL import Image

REVISION = "d525f622e6f640acf5a0fc37c7ca1f243da5bde0"
DIGESTS = {
    "LICENSE": "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4",
    "weights/efficient_sam_vitt.pt": "dff858b19600a46461cbb7de98f796b23a7a888d9f5e34c0b033f7d6eb9e4e6a",
    "weights/efficient_sam_vitt_encoder.onnx": "84ed466ffcc5c1f8d08409bc34a23bb364ab2c15e402cb12d4335a42be0e0951",
    "weights/efficient_sam_vitt_decoder.onnx": "a62f8fa5ea080447c0689418d69e58f1e83e0b7adf9c142e2bd9bcc8045c0b11",
}


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def session(path, provider):
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    options.inter_op_num_threads = 1
    providers = (
        [provider]
        if provider == "CPUExecutionProvider"
        else [provider, "CPUExecutionProvider"]
    )
    return ort.InferenceSession(str(path), sess_options=options, providers=providers)


def probe(
    source, image_path, query_path, output, provider, diagnose_unsupported_negative
):
    revision = subprocess.check_output(
        ["git", "-C", str(source), "rev-parse", "HEAD"], text=True
    ).strip()
    if revision != REVISION or subprocess.check_output(
        ["git", "-C", str(source), "diff", "HEAD", "--"], text=True
    ):
        raise ValueError("EfficientSAM source revision differs from pinned provenance")
    for name, expected in DIGESTS.items():
        if sha256(source / name) != expected:
            raise ValueError(f"EfficientSAM checksum mismatch: {name}")
    if provider not in ort.get_available_providers():
        raise ValueError(f"Unavailable runtime provider: {provider}")
    with Image.open(image_path) as image:
        if image.size != (1024, 1024):
            raise ValueError("Expected a photographic 1024 context, no probe resizing")
        rgb = (
            np.asarray(image.convert("RGB"))
            .copy()
            .transpose(2, 0, 1)[None]
            .astype(np.float32)
            / 255
        )
    queries = json.loads(query_path.read_text())
    if not queries:
        raise ValueError("No segmentation prompts")
    sys.path.insert(0, str(source))
    build = importlib.import_module("efficient_sam.efficient_sam").build_efficient_sam
    wrappers = importlib.import_module("onnx_models")
    model = build(encoder_patch_embed_dim=192, encoder_num_heads=3)
    weights = torch.load(
        source / "weights/efficient_sam_vitt.pt", map_location="cpu", weights_only=True
    )
    model.load_state_dict(weights["model"], strict=True)
    model.eval()
    torch.set_num_threads(4)
    encoder = session(source / "weights/efficient_sam_vitt_encoder.onnx", provider)
    decoder = session(source / "weights/efficient_sam_vitt_decoder.onnx", provider)
    start = time.perf_counter()
    embeddings = encoder.run(None, {"batched_images": rgb})[0]
    encoder_ms = (time.perf_counter() - start) * 1000
    if embeddings.shape != (1, 256, 64, 64) or not np.isfinite(embeddings).all():
        raise ValueError("Encoder shape or finiteness failure")
    output.mkdir(parents=True, exist_ok=True)
    with torch.inference_mode():
        expected_embedding = wrappers.OnnxEfficientSamEncoder(model)(
            torch.from_numpy(rgb)
        )
    embedding_error = float(np.abs(embeddings - expected_embedding.numpy()).max())
    cases = []
    for index, query in enumerate(queries):
        points = np.asarray(query["points"], dtype=np.float32)
        labels = np.asarray(query["labels"], dtype=np.float32)
        if points.shape != (len(labels), 2) or not 1 <= len(labels) <= 6:
            raise ValueError("EfficientSAM requires one through six XY/label prompts")
        if not np.isfinite(points).all() or not np.isin(labels, [0, 1, 2, 3]).all():
            raise ValueError("Invalid point or prompt label")
        unsupported_negative = bool((labels == 0).any())
        if unsupported_negative and not diagnose_unsupported_negative:
            raise ValueError(
                "EfficientSAM has no learned negative prompt embedding; use another model for Smart paint"
            )
        if (points < 0).any() or (points >= 1024).any():
            raise ValueError("Prompt outside photographic context")
        points, labels = points[None, None], labels[None, None]
        size = np.array([1024, 1024], dtype=np.int64)
        feeds = {
            "image_embeddings": embeddings,
            "batched_point_coords": points,
            "batched_point_labels": labels,
            "orig_im_size": size,
        }
        elapsed = []
        for _ in range(10):
            start = time.perf_counter()
            masks, scores, _ = decoder.run(None, feeds)
            elapsed.append((time.perf_counter() - start) * 1000)
        if masks.shape != (1, 1, 3, 1024, 1024) or scores.shape != (1, 1, 3):
            raise ValueError("Decoder native shape mismatch")
        if not np.isfinite(masks).all() or not np.isfinite(scores).all():
            raise ValueError("Decoder emitted non-finite logits or scores")
        with torch.inference_mode():
            expected_masks, expected_scores, _ = wrappers.OnnxEfficientSamDecoder(
                model
            )(
                expected_embedding,
                torch.from_numpy(points),
                torch.from_numpy(labels),
                torch.from_numpy(size),
            )
        choice = int(np.argmax(scores[0, 0]))
        actual = masks[0, 0, choice] >= 0
        reference = expected_masks.numpy()[0, 0, choice] >= 0
        union = np.count_nonzero(actual | reference)
        iou = float(np.count_nonzero(actual & reference) / union) if union else 1.0
        if iou < 0.999:
            raise ValueError(
                "Portable binary mask differs from reference beyond diagnostic bound"
            )
        Image.fromarray(actual.astype(np.uint8) * 255).save(
            output / f"mask-{index}.png"
        )
        prompt_checks = [
            {
                "label": int(label),
                "selected": bool(actual[int(point[1]), int(point[0])]),
                "satisfied": bool(actual[int(point[1]), int(point[0])])
                == bool(label == 1),
            }
            for point, label in zip(points[0, 0], labels[0, 0], strict=True)
            if label in (0, 1)
        ]
        cases.append(
            {
                "query": query,
                "unsupported_negative_diagnostic": unsupported_negative,
                "prompt_checks": prompt_checks,
                "prompts_satisfied": all(check["satisfied"] for check in prompt_checks),
                "choice": choice,
                "predicted_iou": float(scores[0, 0, choice]),
                "selected_pixels": int(actual.sum()),
                "mask_iou_vs_torch": iou,
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
        "digests": DIGESTS,
        "onnxruntime": ort.__version__,
        "provider": provider,
        "image_sha256": sha256(image_path),
        "encoder_elapsed_ms": encoder_ms,
        "max_embedding_error_vs_torch": embedding_error,
        "cases": cases,
        "release_qualified": False,
        "qualification": "Execution parity only. Negative prompts are unsupported; EfficientSAM cannot satisfy the Smart paint contract. Person/object labels, boundary quality, browser and physical-device gates remain",
    }
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    (output / "LICENSE").write_bytes((source / "LICENSE").read_bytes())
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("image_path", type=Path)
    parser.add_argument("query_path", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--provider", default="CPUExecutionProvider")
    parser.add_argument(
        "--diagnose-unsupported-negative",
        action="store_true",
        help="Measure failure of label 0 explicitly; this does not qualify negative prompts",
    )
    print(json.dumps(probe(**vars(parser.parse_args())), indent=2))


if __name__ == "__main__":
    main()
