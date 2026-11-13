"""#3941: challenge deployed Smart paint with actual low-resolution mask input.

Two controls and eight conditioned runs use the same retained RAW encoder,
unchanged prompts and shared candidate validation. This is research, not a
shipping fallback, full silhouette truth or supported-device benchmark.
"""

import argparse
import importlib
import json
import subprocess
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
from export_mobile_sam import PhotographicEncoder, load_model, sha256
from probe_lama_large_scene import mask_values
from probe_person_mask_overlap import content_digest


def sampled(mask, point):
    (x, y, w, h), pixels = mask
    sx, sy = point
    return (
        bool(pixels[sy - y, sx - x]) if x <= sx < x + w and y <= sy < y + h else False
    )


def preflight(args):
    native = json.loads(args.report.read_text())
    points = json.loads(args.points.read_text())
    selection = native["selectionInput"]
    data = (args.report.parent / "selection-encoder.f32").read_bytes()
    if (
        ort.__version__ != "1.23.2"
        or points["nativeReportSHA256"] != sha256(args.report)
        or points["source"] != native["source"]
        or content_digest(args.raw.read_bytes()) != native["source"]["original"]
        or selection["encoderShape"] != [1, 3, 1024, 1024]
        or selection["encoderDomain"] != "RGB float32 LE 0..255"
        or len(data) != 3 * 1024 * 1024 * 4
        or content_digest(data) != selection["encoderDigest"]
        or content_digest((args.report.parent / "selection-proxy.rgb8").read_bytes())
        != selection["proxyDigest"]
    ):
        raise ValueError("Retained RAW, photographic encoder or point protocol changed")
    requests = [json.loads(p.read_text()) for p in [args.initial, args.refined]]
    for request in requests:
        if (
            [request["source_width"], request["source_height"]]
            != [native["source"]["width"], native["source"]["height"]]
            or request["window"]
            != {
                "x": 0,
                "y": 0,
                "width": request["source_width"],
                "height": request["source_height"],
            }
            or [request["input_width"], request["input_height"]]
            != selection["contentSize"]
            or any(p["label"] not in [0, 1] for p in request["prompts"])
        ):
            raise ValueError("Use exact full-frame point-only Smart requests")
    if (
        requests[1]["prompts"][:-1] != requests[0]["prompts"]
        or requests[1]["strokes"][:-1] != requests[0]["strokes"]
        or requests[1]["prompts"][-1]["label"] != 0
        or not requests[1]["strokes"][-1]["subtract"]
    ):
        raise ValueError(
            "Refinement must add exactly one negative to the unchanged intent"
        )
    neighbor = points["exclude"]["hooded_neighbor"]
    expected = [
        float(np.float32((value + 0.5) / native["source"][dimension]))
        for value, dimension in zip(neighbor, ["width", "height"], strict=True)
    ]
    if requests[1]["prompts"][-1]["position"] != expected or np.asarray(
        requests[1]["strokes"][-1]["points"], np.float32
    ).tolist() != [expected]:
        raise ValueError("Negative refinement must target the recorded neighbor sample")
    pins = [
        p
        for p in json.loads(
            Path(__file__).with_name("removal-models.generated.json").read_text()
        )
        if p["id"] in ["encoder", "decoder"]
    ]
    for pin in pins:
        file = args.models / pin["file"]
        if file.stat().st_size != pin["size"] or sha256(file) != pin["sha256"]:
            raise ValueError("Deployed model checksum or size changed")
    rgb = np.frombuffer(data, "<f4").reshape(1, 3, 1024, 1024)
    if not np.isfinite(rgb).all() or rgb.min() < 0 or rgb.max() > 255:
        raise ValueError("Invalid photographic encoder floats")
    return native, points, rgb, pins


def run(args):
    native, points, rgb, pins = preflight(args)
    if args.output.exists():
        raise ValueError("Choose a fresh conditioning output")
    # Verify upstream source/weights before inference or output publication.
    import torch

    torch.set_num_threads(4)
    model = load_model(args.upstream)
    wrapper = (
        importlib.import_module("mobile_sam.utils.onnx")
        .SamOnnxModel(model, return_single_mask=False)
        .eval()
    )
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    options.inter_op_num_threads = 1
    encoder = ort.InferenceSession(
        str(args.models / "mobile-sam-encoder.onnx"),
        sess_options=options,
        providers=["CPUExecutionProvider"],
    )
    decoder = ort.InferenceSession(
        str(args.models / "mobile-sam-decoder.onnx"),
        sess_options=options,
        providers=["CPUExecutionProvider"],
    )
    embedding = encoder.run(None, {"image": rgb})[0]
    with torch.inference_mode():
        reference_embedding = PhotographicEncoder(model).eval()(
            torch.from_numpy(rgb.copy())
        )
    if embedding.shape != (1, 256, 64, 64) or not np.isfinite(embedding).all():
        raise ValueError("Invalid real embedding")
    args.output.mkdir()
    rows = []

    def execute(name, request_path, mask, has_mask):
        prompt_path = args.output / (name + "-prompts.json")
        subprocess.run(
            [str(args.probe), "--prompts", str(request_path), str(prompt_path)],
            check=True,
            capture_output=True,
        )
        prompts = json.loads(prompt_path.read_text())
        inputs = {
            "image_embeddings": embedding,
            "point_coords": np.asarray([prompts["points"]], np.float32),
            "point_labels": np.asarray([prompts["labels"]], np.float32),
            "mask_input": mask,
            "has_mask_input": np.array([has_mask], np.float32),
            "orig_im_size": np.array([1024, 1024], np.float32),
        }
        started = time.perf_counter()
        actual = decoder.run(None, inputs)
        elapsed = time.perf_counter() - started
        with torch.inference_mode():
            tensors = [torch.from_numpy(v.copy()) for v in inputs.values()]
            tensors[0] = reference_embedding
            reference = [v.detach().cpu().numpy() for v in wrapper(*tensors)]
        row = {
            "name": name,
            "requestSHA256": sha256(request_path),
            "maskInputDigest": content_digest(mask.astype("<f4").tobytes()),
            "hasMaskInput": has_mask,
            "decodeSeconds": elapsed,
            "modelComparison": [],
        }
        accepted = []
        for owner, values in [("runtime", actual), ("upstream", reference)]:
            logits, scores, low = values
            if [v.shape for v in values] != [
                (1, 4, 1024, 1024),
                (1, 4),
                (1, 4, 256, 256),
            ] or not all(np.isfinite(v).all() for v in values):
                raise ValueError("Invalid real decoder output")
            prefix = args.output / (name + "-" + owner)
            logit_path, score_path, mask_path = (
                prefix.with_suffix(".f32"),
                prefix.with_suffix(".json"),
                prefix.with_suffix(".mimf"),
            )
            logits.astype("<f4").tofile(logit_path)
            scores_path = score_path.with_name(score_path.stem + "-scores.json")
            scores_path.write_text(json.dumps(scores[0].tolist()) + "\n")
            low.astype("<f4").tofile(prefix.with_name(prefix.name + "-low.f32"))
            completed = subprocess.run(
                [
                    str(args.probe),
                    str(request_path),
                    str(logit_path),
                    str(scores_path),
                    str(mask_path),
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            result = {"scores": scores[0].tolist()}
            indices = np.floor(np.asarray(prompts["points"]) + 0.5).astype(int)
            votes = [logits[0, c, indices[:, 1], indices[:, 0]] > 0 for c in range(4)]
            result["violations"] = [
                [
                    i
                    for i, label in enumerate(prompts["labels"])
                    if label in [0, 1] and bool(vote[i]) != (label == 1)
                ]
                for vote in votes
            ]
            if bool(completed.returncode == 0) != any(
                not v for v in result["violations"]
            ):
                raise ValueError(
                    "Independent prompt votes disagree with shared validation"
                )
            if completed.returncode:
                result["sharedRejected"] = completed.stderr.strip()
                accepted.append(None)
            else:
                data = mask_path.read_bytes()
                native_mask = mask_values(data, native["source"])
                result.update(
                    maskDigest=content_digest(data),
                    nativePixels=int(native_mask[1].sum()),
                    visibleSamples={
                        n: sampled(native_mask, p) for n, p in points["points"].items()
                    },
                    neighborSelected=sampled(
                        native_mask, points["exclude"]["hooded_neighbor"]
                    ),
                )
                accepted.append(data)
            row[owner] = result
        row["modelComparison"] = [
            float(np.max(np.abs(a - b))) for a, b in zip(actual, reference, strict=True)
        ]
        row["nativeMaskExact"] = accepted[0] is not None and accepted[0] == accepted[1]
        row["sharedDecisionAgrees"] = (accepted[0] is None) == (accepted[1] is None)
        mask.astype("<f4").tofile(args.output / (name + "-mask-input.f32"))
        rows.append(row)
        print(json.dumps(row), flush=True)
        return actual[2]

    blank = np.zeros((1, 1, 256, 256), np.float32)
    prior = execute("initial-control", args.initial, blank, 0)
    failed = execute("negative-control", args.refined, blank, 0)
    for seed_name, seeds in [("prior", prior), ("negative", failed)]:
        for candidate in range(4):
            execute(
                f"{seed_name}-candidate-{candidate}",
                args.refined,
                seeds[:, candidate : candidate + 1].copy(),
                1,
            )
    if content_digest(args.raw.read_bytes()) != native["source"]["original"]:
        raise ValueError("Original RAW changed")
    result = {
        "probeSHA256": sha256(Path(__file__)),
        "sharedProbeSHA256": sha256(args.probe),
        "nativeReportSHA256": sha256(args.report),
        "pointProtocolSHA256": sha256(args.points),
        "source": native["source"],
        "selectionInput": native["selectionInput"],
        "modelPins": pins,
        "runtime": ort.__version__,
        "upstreamSource": str(args.upstream),
        "upstreamRevision": subprocess.check_output(
            ["git", "-C", str(args.upstream), "rev-parse", "HEAD"], text=True
        ).strip(),
        "embeddingMaxError": float(
            np.max(np.abs(embedding - reference_embedding.numpy()))
        ),
        "cases": rows,
        "originalUnchanged": True,
        "releaseQualified": False,
        "scope": "Actual paired CPU ORT/PyTorch with identical recorded mask-input tensors and unchanged prompts; shared admission remains strict. Sparse manual samples on one RAW do not prove complete silhouette, ownership, reconstruction quality or supported-device budgets. No product change.",
    }
    (args.output / "report.json").write_text(json.dumps(result, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in [
        "report",
        "raw",
        "points",
        "models",
        "probe",
        "initial",
        "refined",
        "upstream",
        "output",
    ]:
        parser.add_argument(name, type=Path)
    run(parser.parse_args())
