"""#3941: pinned stock SAM2 image masks on retained RAW person inputs.

Sparse visible points are diagnostics, not complete silhouette/ownership truth.
Use the upstream predictor unchanged, CPU fp32 and the shared native MIMF map.
Requires the pinned upstream source and hydra-core alongside research deps.
"""

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
from export_mobile_sam import sha256
from PIL import Image
from probe_person_mask_overlap import common_pixels, content_digest, read_mask


def preflight(report_path, raw, source, weights, points_path, pins_path):
    pins = json.loads(pins_path.read_text())
    revision = subprocess.check_output(
        ["git", "-C", str(source), "rev-parse", "HEAD"], text=True
    ).strip()
    if revision != pins["revision"] or subprocess.check_output(
        ["git", "-C", str(source), "status", "--porcelain"], text=True
    ):
        raise ValueError("SAM2 source revision or clean-tree contract changed")
    for name, digest in pins["files"].items():
        if sha256(source / name) != digest:
            raise ValueError("Pinned SAM2 source file changed: " + name)
    if (
        weights.stat().st_size != pins["weightsBytes"]
        or sha256(weights) != pins["weightsSHA256"]
    ):
        raise ValueError("Pinned SAM2 weights changed")
    native = json.loads(report_path.read_text())
    original = raw.read_bytes()
    points = json.loads(points_path.read_text())
    selection = native["selectionInput"]
    width, height = selection["proxySize"]
    proxy = (report_path.parent / "selection-proxy.rgb8").read_bytes()
    if (
        content_digest(original) != native["source"]["original"]
        or sha256(raw) != points["rawSHA256"]
        or sha256(report_path) != points["nativeReportSHA256"]
        or points["proxyDigest"] != selection["proxyDigest"]
        or points["proxySize"] != [width, height]
        or [width, height] != selection["contentSize"]
        or max(width, height) > 1024
        or min(width, height) <= 0
        or len(proxy) != width * height * 3
        or content_digest(proxy) != selection["proxyDigest"]
    ):
        raise ValueError("RAW, retained proxy or visible-point identity changed")
    ids = {person["id"] for person in native["detected"]}
    records = native["detectedMasks"]
    if len(ids) != len(native["detected"]) or {row["id"] for row in records} != ids:
        raise ValueError("Retained detector and native mask IDs changed")
    size = [native["source"][key] for key in ["width", "height"]]
    retained = {row["id"]: read_mask(report_path.parent, row, size) for row in records}
    for case in points["cases"]:
        if not set(case["personIds"]).issubset(ids):
            raise ValueError("Visible-point person IDs changed")
        for key in ["include", "exclude", "positive", "negative"]:
            values = np.asarray(case[key], dtype=np.float32)
            if (
                values.ndim != 2
                or values.shape[1] != 2
                or not np.isfinite(values).all()
                or (values < 0).any()
                or (values[:, 0] >= width).any()
                or (values[:, 1] >= height).any()
            ):
                raise ValueError("Invalid visible sample or prompt")
    return pins, native, points, original, proxy, retained


def sampled(mask, points, source_size, proxy_size):
    if mask is None:
        return [False] * len(points)
    (x, y, width, height), values = mask
    positions = [
        [
            int((px + 0.5) * source_size[0] / proxy_size[0]),
            int((py + 0.5) * source_size[1] / proxy_size[1]),
        ]
        for px, py in points
    ]
    return [
        bool(values[py - y, px - x])
        if x <= px < x + width and y <= py < y + height
        else False
        for px, py in positions
    ]


def run(
    report_path, raw, source, weights, points_path, pins_path, shared_probe, output
):
    pins, native, annotations, original, proxy, retained = preflight(
        report_path, raw, source, weights, points_path, pins_path
    )
    if output.exists():
        raise ValueError("Choose a fresh SAM2 diagnostic output")
    sys.path.insert(0, str(source.resolve()))
    import torch
    from sam2.build_sam import build_sam2
    from sam2.sam2_image_predictor import SAM2ImagePredictor

    torch.set_num_threads(4)
    model = build_sam2(pins["config"], str(weights), device="cpu")
    predictor = SAM2ImagePredictor(model)
    width, height = native["selectionInput"]["proxySize"]
    size = [native["source"][key] for key in ["width", "height"]]
    rgb = np.frombuffer(proxy, dtype=np.uint8).reshape(height, width, 3).copy()
    encoder_inputs = []
    hook = model.image_encoder.register_forward_pre_hook(
        lambda _module, args: encoder_inputs.append(args[0].detach().clone())
    )
    started = time.perf_counter()
    try:
        predictor.set_image(rgb)
    finally:
        hook.remove()
    encoder_seconds = time.perf_counter() - started
    if len(encoder_inputs) != 1 or encoder_inputs[0].shape != (1, 3, 1024, 1024):
        raise ValueError("Unexpected actual SAM2 encoder input")
    encoded_input = encoder_inputs[0].cpu().numpy()
    if not np.isfinite(encoded_input).all():
        raise ValueError("Non-finite actual SAM2 encoder input")
    output.mkdir(parents=True)
    encoded_input.astype("<f4").tofile(output / "encoder-input.f32")
    Image.fromarray(rgb).save(output / "source-proxy.png")
    rows = []
    for person in native["detected"]:
        identifier = person["id"]
        x, y, right, bottom = person["bounds"]
        box = np.array(
            [
                x * width / size[0],
                y * height / size[1],
                right * width / size[0],
                bottom * height / size[1],
            ],
            dtype=np.float32,
        )
        annotated = next(
            (case for case in annotations["cases"] if identifier in case["personIds"]),
            None,
        )
        arms = ["single", "multi"] + (["refined", "points"] if annotated else [])
        for arm in arms:
            coords = (
                np.array(
                    annotated["positive"] + annotated["negative"], dtype=np.float32
                )
                + 0.5
                if arm in ["refined", "points"]
                else None
            )
            labels = (
                np.array(
                    [1] * len(annotated["positive"]) + [0] * len(annotated["negative"]),
                    dtype=np.int32,
                )
                if arm in ["refined", "points"]
                else None
            )
            request = {
                "schema": 1,
                "source_width": size[0],
                "source_height": size[1],
                "window": {"x": 0, "y": 0, "width": size[0], "height": size[1]},
                "input_width": width,
                "input_height": height,
                "prompts": (
                    []
                    if arm == "points"
                    else [
                        {"position": [x / size[0], y / size[1]], "label": 2},
                        {"position": [right / size[0], bottom / size[1]], "label": 3},
                    ]
                )
                + (
                    [
                        {
                            "position": [float(px / width), float(py / height)],
                            "label": int(label),
                        }
                        for (px, py), label in zip(coords, labels, strict=True)
                    ]
                    if coords is not None
                    else []
                ),
                "strokes": [],
            }
            request_path = output / f"person-{identifier}-{arm}.json"
            request_path.write_text(json.dumps(request) + "\n")
            started = time.perf_counter()
            with torch.inference_mode():
                logits, scores, low = predictor.predict(
                    point_coords=coords,
                    point_labels=labels,
                    box=None if arm == "points" else box,
                    multimask_output=arm == "multi",
                    return_logits=True,
                )
            elapsed = time.perf_counter() - started
            count = 3 if arm == "multi" else 1
            if (
                logits.shape != (count, height, width)
                or scores.shape != (count,)
                or low.shape != (count, 256, 256)
                or not all(np.isfinite(v).all() for v in [logits, scores, low])
            ):
                raise ValueError("Invalid upstream SAM2 output")
            np.savez(
                output / f"output-{identifier}-{arm}.npz",
                logits=logits,
                scores=scores,
                low=low,
            )
            candidates = []
            for index in range(count):
                plane = np.full((1024, 1024), -1, dtype=np.float32)
                plane[:height, :width] = logits[index]
                # Four equal planes adapt only this diagnostic transport. No
                # MobileSAM graph, ranking or learned logits are substituted.
                logit_path = output / "candidate.f32"
                np.tile(plane[None], (4, 1, 1)).astype("<f4").tofile(logit_path)
                score_path = output / "candidate-scores.json"
                score_path.write_text("[1, 0, 0, 0]\n")
                destination = output / f"{arm}-{index}"
                destination.mkdir(exist_ok=True)
                mask_path = destination / f"detected-{identifier}.mimf"
                completed = subprocess.run(
                    [
                        str(shared_probe),
                        str(request_path),
                        str(logit_path),
                        str(score_path),
                        str(mask_path),
                    ],
                    capture_output=True,
                    text=True,
                    check=False,
                )
                binary = logits[index] > 0
                Image.fromarray(binary.astype(np.uint8) * 255).save(
                    output / f"mask-{identifier}-{arm}-{index}.png"
                )
                image = rgb.copy()
                image[binary] = (
                    image[binary].astype(np.float32) * 0.55
                    + np.array([35, 220, 105]) * 0.45
                ).astype(np.uint8)
                Image.fromarray(image).save(
                    output / f"overlay-{identifier}-{arm}-{index}.png"
                )
                if completed.returncode:
                    candidates.append(
                        {
                            "candidate": index,
                            "sharedRejected": completed.stderr.strip(),
                            "score": float(scores[index]),
                        }
                    )
                    continue
                data = mask_path.read_bytes()
                mask = read_mask(
                    destination,
                    {
                        "id": identifier,
                        "file": mask_path.name,
                        "digest": content_digest(data),
                    },
                    size,
                )
                samples = (
                    {
                        key: sampled(mask, annotated[key], size, [width, height])
                        for key in ["include", "exclude"]
                    }
                    if annotated
                    else None
                )
                candidates.append(
                    {
                        "candidate": index,
                        "score": float(scores[index]),
                        "nativePixels": int(mask[1].sum()) if mask is not None else 0,
                        "maskDigest": content_digest(data),
                        "commonWithRetained": common_pixels(mask, retained[identifier]),
                        "visibleSamples": samples,
                    }
                )
            rows.append(
                {
                    "personId": identifier,
                    "arm": arm,
                    "proxyBox": box.tolist(),
                    "requestSHA256": sha256(request_path),
                    "decodeSeconds": elapsed,
                    "rankedChoice": int(np.argmax(scores)),
                    "candidates": candidates,
                }
            )
            print(f"Person {identifier} {arm}: scores={scores.tolist()}", flush=True)
    (output / "candidate.f32").unlink()
    result = {
        "pins": pins,
        "nativeReportSHA256": sha256(report_path),
        "rawSHA256": sha256(raw),
        "pointProtocolSHA256": sha256(points_path),
        "sharedProbeSHA256": sha256(shared_probe),
        "source": native["source"],
        "selectionInput": native["selectionInput"],
        "torch": torch.__version__,
        "device": "CPU fp32",
        "threads": 4,
        "stateTensorEntries": len(model.state_dict()),
        "encoderSeconds": encoder_seconds,
        "actualEncoderInput": {
            "file": "encoder-input.f32",
            "sha256": sha256(output / "encoder-input.f32"),
            "shape": [1, 3, 1024, 1024],
            "domain": "Unmodified upstream square resize/ImageNet RGB normalization, fp32",
        },
        "retainedProductionSamples": [
            {
                "personId": identifier,
                "description": case["description"],
                "include": sampled(
                    retained[identifier], case["include"], size, [width, height]
                ),
                "exclude": sampled(
                    retained[identifier], case["exclude"], size, [width, height]
                ),
            }
            for case in annotations["cases"]
            for identifier in case["personIds"]
        ],
        "upstreamPostprocessing": {
            "dynamicMultimaskStabilityFallback": True,
            "holeFill": 0,
            "sprinkleRemoval": 0,
        },
        "cases": rows,
        "releaseQualified": False,
        "scope": "Exact RAW-derived production RGB proxy, unmodified pinned SAM2 image predictor, actual box/positive/negative prompts and shared native mask conversion. Sparse pre-output visible points are diagnostics, not complete silhouettes, ownership truth, Auto background roles, native/browser adapter parity, photographic fills or supported-device performance qualification.",
    }
    (output / "report.json").write_text(json.dumps(result, indent=2) + "\n")
    if raw.read_bytes() != original:
        raise ValueError("Original RAW changed")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in [
        "report_path",
        "raw",
        "source",
        "weights",
        "points_path",
        "pins_path",
        "shared_probe",
        "output",
    ]:
        parser.add_argument(name, type=Path)
    run(**vars(parser.parse_args()))
