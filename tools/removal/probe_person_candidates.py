"""#3941: audit all SAM mask tokens on retained production person inputs.

Replays the exact Swift encoder tensor and shared Rust prompt/native-mask
mapping. Candidate geometry is not distinct-person ownership or closure truth.
Requires numpy, onnxruntime, torch, pillow and blake3 in a research environment.
"""

import argparse
import json
import subprocess
from pathlib import Path

import numpy as np
from export_mobile_sam import sha256
from PIL import Image
from probe_mobile_sam import session
from probe_person_mask_overlap import common_pixels, content_digest, read_mask


def run(report_path, raw, artifacts, shared_probe, output):
    report_bytes = report_path.read_bytes()
    native = json.loads(report_bytes)
    original = raw.read_bytes()
    if content_digest(original) != native["source"]["original"]:
        raise ValueError("RAW differs from retained production source")
    selection = native["selectionInput"]
    encoder_bytes = (report_path.parent / "selection-encoder.f32").read_bytes()
    proxy_bytes = (report_path.parent / "selection-proxy.rgb8").read_bytes()
    if (
        content_digest(encoder_bytes) != selection["encoderDigest"]
        or content_digest(proxy_bytes) != selection["proxyDigest"]
        or selection["encoderShape"] != [1, 3, 1024, 1024]
        or selection["encoderDomain"] != "RGB float32 LE 0..255"
        or len(encoder_bytes) != 3 * 1024 * 1024 * 4
        or len(proxy_bytes) != int(np.prod(selection["proxySize"])) * 3
    ):
        raise ValueError("Retained production selection input identity mismatch")
    rgb = np.frombuffer(encoder_bytes, dtype="<f4").reshape(1, 3, 1024, 1024)
    if not np.isfinite(rgb).all() or rgb.min() < 0 or rgb.max() > 255:
        raise ValueError("Invalid production encoder tensor")
    if output.exists():
        raise ValueError("Choose a fresh candidate audit output")
    encoder = session(artifacts / "mobile-sam-encoder.onnx", "CPUExecutionProvider")
    decoder = session(artifacts / "mobile-sam-decoder.onnx", "CPUExecutionProvider")
    embeddings = encoder.run(None, {"image": rgb})[0]
    if embeddings.shape != (1, 256, 64, 64) or not np.isfinite(embeddings).all():
        raise ValueError("Invalid model embedding")
    output.mkdir(parents=True)
    size = [native["source"][key] for key in ["width", "height"]]
    records = {row["id"]: row for row in native["detectedMasks"]}
    if set(records) != {row["id"] for row in native["detected"]}:
        raise ValueError("Retained instance IDs differ from production detections")
    content_w, content_h = selection["contentSize"]
    masks_by_policy = {"production": {}, "whole_object_token": {}}
    cases = []
    for person in native["detected"]:
        identifier = person["id"]
        retained = read_mask(report_path.parent, records[identifier], size)
        x, y, right, bottom = person["bounds"]
        if not (0 <= x < right <= size[0] and 0 <= y < bottom <= size[1]):
            raise ValueError("Invalid retained XYXY detector box")
        request = {
            "schema": 1,
            "source_width": size[0],
            "source_height": size[1],
            "window": {"x": 0, "y": 0, "width": size[0], "height": size[1]},
            "input_width": content_w,
            "input_height": content_h,
            "prompts": [
                {"position": [x / size[0], y / size[1]], "label": 2},
                {
                    "position": [right / size[0], bottom / size[1]],
                    "label": 3,
                },
            ],
            "strokes": [],
        }
        request_path = output / f"person-{identifier}.json"
        request_path.write_text(json.dumps(request) + "\n")
        prompt_path = output / f"prompts-{identifier}.json"
        subprocess.run(
            [str(shared_probe), "--prompts", str(request_path), str(prompt_path)],
            check=True,
            capture_output=True,
        )
        prompts = json.loads(prompt_path.read_text())
        feeds = {
            "image_embeddings": embeddings,
            "point_coords": np.asarray([prompts["points"]], dtype=np.float32),
            "point_labels": np.asarray([prompts["labels"]], dtype=np.float32),
            "mask_input": np.zeros((1, 1, 256, 256), dtype=np.float32),
            "has_mask_input": np.zeros(1, dtype=np.float32),
            "orig_im_size": np.array([1024, 1024], dtype=np.float32),
        }
        logits, scores, low = decoder.run(None, feeds)
        if (
            logits.shape != (1, 4, 1024, 1024)
            or scores.shape != (1, 4)
            or low.shape != (1, 4, 256, 256)
            or not all(np.isfinite(values).all() for values in [logits, scores, low])
        ):
            raise ValueError("Invalid model candidate output")
        logits_path = output / f"logits-{identifier}.f32"
        logits.astype("<f4").tofile(logits_path)

        def replay(
            candidate_scores,
            label,
            identifier=identifier,
            request_path=request_path,
            logits_path=logits_path,
        ):
            score_path = output / f"scores-{identifier}-{label}.json"
            score_path.write_text(json.dumps(candidate_scores) + "\n")
            mask_path = output / f"person-{identifier}-{label}.mimf"
            subprocess.run(
                [
                    str(shared_probe),
                    str(request_path),
                    str(logits_path),
                    str(score_path),
                    str(mask_path),
                ],
                check=True,
                capture_output=True,
            )
            data = mask_path.read_bytes()
            # Reuse the strict native asset reader, whose naming contract binds
            # records to detected IDs. Files remain diagnostic, never sidecars.
            destination = output / label
            destination.mkdir(exist_ok=True)
            (destination / f"detected-{identifier}.mimf").write_bytes(data)
            mask = read_mask(
                destination,
                {
                    "id": identifier,
                    "file": f"detected-{identifier}.mimf",
                    "digest": content_digest(data),
                },
                size,
            )
            return data, mask

        data, production = replay(scores[0].tolist(), "production")
        matches = content_digest(data) == records[identifier]["digest"]
        candidates = []
        for token in range(4):
            binary = logits[0, token, :content_h, :content_w] > 0
            pixels = int(binary.sum())
            if not pixels:
                candidates.append({"token": token, "proxyPixels": 0})
                continue
            ranked = [0.0] * 4
            ranked[token] = 1000.0
            candidate_bytes, mask = replay(ranked, f"token-{token}")
            Image.fromarray(binary.astype(np.uint8) * 255).save(
                output / f"person-{identifier}-token-{token}.png"
            )
            candidates.append(
                {
                    "token": token,
                    "score": float(scores[0, token]),
                    "proxyPixels": pixels,
                    "nativePixels": int(mask[1].sum()),
                    "maskDigest": content_digest(candidate_bytes),
                    "commonWithRetained": common_pixels(mask, retained),
                }
            )
            if token == 0:
                masks_by_policy["whole_object_token"][identifier] = mask
        masks_by_policy["production"][identifier] = production
        cases.append(
            {
                "person": person,
                "productionReplayedExactly": matches,
                "rankedChoice": int(np.argmax(scores[0])),
                "candidates": candidates,
            }
        )
        print(
            f"Person {identifier}: exact replay={matches}, best={np.argmax(scores[0])}",
            flush=True,
        )
    pairs = {}
    for policy, masks in masks_by_policy.items():
        ids = sorted(masks)
        pairs[policy] = [
            {"first": a, "second": b, "commonPixels": common_pixels(masks[a], masks[b])}
            for i, a in enumerate(ids)
            for b in ids[i + 1 :]
            if common_pixels(masks[a], masks[b])
        ]
    result = {
        "nativeReportSHA256": sha256(report_path),
        "rawSHA256": sha256(raw),
        "sharedProbeSHA256": sha256(shared_probe),
        "selectionInput": selection,
        "onnxruntime": __import__("onnxruntime").__version__,
        "artifacts": {
            name: sha256(artifacts / f"mobile-sam-{name}.onnx")
            for name in ["encoder", "decoder"]
        },
        "cases": cases,
        "overlapPairs": pairs,
        "releaseQualified": False,
        "scope": "Exact retained production tensor, actual box prompts and all four SAM tokens through the shared native boundary. Token 0 comparison is diagnostic; no ownership, complete-silhouette or photographic fill qualification.",
    }
    (output / "report.json").write_text(json.dumps(result, indent=2) + "\n")
    if raw.read_bytes() != original:
        raise ValueError("Original RAW changed")
    if not all(case["productionReplayedExactly"] for case in cases):
        raise ValueError(
            "Runtime replay differs; do not attribute changes to token choice alone"
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["report_path", "raw", "artifacts", "shared_probe", "output"]:
        parser.add_argument(name, type=Path)
    run(**vars(parser.parse_args()))
