"""#3941: exact deployed MobileSAM versus SAM2 diagnostic prompt requests.

Use retained production encoder floats and official macOS ORT1.23.2 CPU.
This compares actual selections, not full silhouette or photographic quality.
"""

import argparse
import json
import subprocess
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
from export_mobile_sam import sha256
from PIL import Image
from probe_person_mask_overlap import content_digest, read_mask
from probe_sam2_people import sampled


def run(report_path, raw, sam2_report, points_path, artifacts, shared_probe, output):
    native = json.loads(report_path.read_text())
    reference = json.loads(sam2_report.read_text())
    annotations = json.loads(points_path.read_text())
    original = raw.read_bytes()
    selection = native["selectionInput"]
    width, height = selection["proxySize"]
    size = [native["source"][key] for key in ["width", "height"]]
    encoder_bytes = (report_path.parent / "selection-encoder.f32").read_bytes()
    proxy = (report_path.parent / "selection-proxy.rgb8").read_bytes()
    if (
        ort.__version__ != "1.23.2"
        or reference["nativeReportSHA256"] != sha256(report_path)
        or reference["rawSHA256"] != sha256(raw)
        or reference["pointProtocolSHA256"] != sha256(points_path)
        or reference["sharedProbeSHA256"] != sha256(shared_probe)
        or reference["selectionInput"] != selection
        or content_digest(original) != native["source"]["original"]
        or content_digest(encoder_bytes) != selection["encoderDigest"]
        or content_digest(proxy) != selection["proxyDigest"]
        or len(encoder_bytes) != 3 * 1024 * 1024 * 4
        or len(proxy) != width * height * 3
    ):
        raise ValueError("Runtime or matched RAW/protocol/input identity changed")
    requests = []
    for row in reference["cases"]:
        path = sam2_report.parent / f"person-{row['personId']}-{row['arm']}.json"
        if sha256(path) != row["requestSHA256"]:
            raise ValueError("Actual SAM2 prompt request changed")
        requests.append(path)
    pins = json.loads(
        Path(__file__).with_name("removal-models.generated.json").read_text()
    )
    model_pins = [row for row in pins if row["id"] in ["encoder", "decoder"]]
    for pin in model_pins:
        path = artifacts / pin["file"]
        if path.stat().st_size != pin["size"] or sha256(path) != pin["sha256"]:
            raise ValueError("Actual deployed MobileSAM model bytes changed")
    if output.exists():
        raise ValueError("Choose a fresh matched-model output")
    output.mkdir(parents=True)
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    options.inter_op_num_threads = 1
    encoder = ort.InferenceSession(
        str(artifacts / "mobile-sam-encoder.onnx"),
        sess_options=options,
        providers=["CPUExecutionProvider"],
    )
    decoder = ort.InferenceSession(
        str(artifacts / "mobile-sam-decoder.onnx"),
        sess_options=options,
        providers=["CPUExecutionProvider"],
    )
    rgb = np.frombuffer(encoder_bytes, dtype="<f4").reshape(1, 3, 1024, 1024)
    started = time.perf_counter()
    embeddings = encoder.run(None, {"image": rgb})[0]
    encoder_seconds = time.perf_counter() - started
    if embeddings.shape != (1, 256, 64, 64) or not np.isfinite(embeddings).all():
        raise ValueError("Invalid real deployed embedding")
    rows = []
    image = np.frombuffer(proxy, dtype=np.uint8).reshape(height, width, 3)
    for row, request_path in zip(reference["cases"], requests, strict=True):
        identifier, arm = row["personId"], row["arm"]
        prefix = f"person-{identifier}-{arm}"
        prompt_path = output / (prefix + "-prompts.json")
        subprocess.run(
            [str(shared_probe), "--prompts", str(request_path), str(prompt_path)],
            check=True,
            capture_output=True,
        )
        prompts = json.loads(prompt_path.read_text())
        started = time.perf_counter()
        logits, scores, low = decoder.run(
            None,
            {
                "image_embeddings": embeddings,
                "point_coords": np.asarray([prompts["points"]], dtype=np.float32),
                "point_labels": np.asarray([prompts["labels"]], dtype=np.float32),
                "mask_input": np.zeros((1, 1, 256, 256), dtype=np.float32),
                "has_mask_input": np.zeros(1, dtype=np.float32),
                "orig_im_size": np.array([1024, 1024], dtype=np.float32),
            },
        )
        elapsed = time.perf_counter() - started
        if (
            logits.shape != (1, 4, 1024, 1024)
            or scores.shape != (1, 4)
            or low.shape != (1, 4, 256, 256)
            or not all(np.isfinite(v).all() for v in [logits, scores, low])
        ):
            raise ValueError("Invalid deployed model output")
        logit_path = output / (prefix + ".f32")
        logits.astype("<f4").tofile(logit_path)
        score_path = output / (prefix + "-scores.json")
        score_path.write_text(json.dumps(scores[0].tolist()) + "\n")
        destination = output / (prefix + "-selected")
        destination.mkdir()
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
        result = {
            "personId": identifier,
            "arm": arm,
            "requestSHA256": sha256(request_path),
            "scores": scores[0].tolist(),
            "decodeSeconds": elapsed,
        }
        if completed.returncode:
            result["sharedRejected"] = completed.stderr.strip()
        else:
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
            result["maskDigest"] = content_digest(data)
            result["nativePixels"] = int(mask[1].sum()) if mask else 0
            case = next(
                (v for v in annotations["cases"] if identifier in v["personIds"]), None
            )
            if case:
                result["visibleSamples"] = {
                    key: sampled(mask, case[key], size, [width, height])
                    for key in ["include", "exclude"]
                }
            ys = np.minimum(
                size[1] - 1, ((np.arange(height) + 0.5) * size[1] / height).astype(int)
            )
            xs = np.minimum(
                size[0] - 1, ((np.arange(width) + 0.5) * size[0] / width).astype(int)
            )
            binary = np.zeros((height, width), dtype=bool)
            if mask:
                (x, y, w, h), values = mask
                rows_inside = (ys >= y) & (ys < y + h)
                cols_inside = (xs >= x) & (xs < x + w)
                binary[np.ix_(rows_inside, cols_inside)] = values[
                    np.ix_(ys[rows_inside] - y, xs[cols_inside] - x)
                ]
            overlay = image.copy()
            overlay[binary] = (
                overlay[binary].astype(np.float32) * 0.55
                + np.array([35, 220, 105]) * 0.45
            ).astype(np.uint8)
            Image.fromarray(overlay).save(output / (prefix + ".png"))
        rows.append(result)
        print(
            prefix,
            result.get("visibleSamples", result.get("sharedRejected")),
            flush=True,
        )
    result = {
        "sam2ReportSHA256": sha256(sam2_report),
        "nativeReportSHA256": sha256(report_path),
        "rawSHA256": sha256(raw),
        "pointProtocolSHA256": sha256(points_path),
        "sharedProbeSHA256": sha256(shared_probe),
        "actualModelPins": model_pins,
        "onnxruntime": ort.__version__,
        "encoderSeconds": encoder_seconds,
        "device": "CPU fp32",
        "threads": 4,
        "cases": rows,
        "originalUnchanged": raw.read_bytes() == original,
        "releaseQualified": False,
        "scope": "Same exact logical source prompts as actual SAM2 requests, actual retained production MobileSAM encoder tensor, shared prompt/native mask validation and deployed pinned ORT1.23.2 CPU. Sparse visible samples are diagnostics, not independent closure/ownership truth or supported-device speed.",
    }
    if not result["originalUnchanged"]:
        raise ValueError("Original RAW changed")
    (output / "report.json").write_text(json.dumps(result, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in [
        "report_path",
        "raw",
        "sam2_report",
        "points_path",
        "artifacts",
        "shared_probe",
        "output",
    ]:
        parser.add_argument(name, type=Path)
    run(**vars(parser.parse_args()))
