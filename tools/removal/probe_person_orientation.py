"""#3941: actual deployed person detector on native versus upright RAW pixels.

Shared Rust verifies the RAW EXIF tag and permutes pixels exactly. Tensor
interpolation is first checked against a retained production Swift encoder.
This diagnoses detection input framing; it never changes app/model admission.
"""

import argparse
import json
import subprocess
from pathlib import Path

import numpy as np
import onnxruntime as ort
from export_mobile_sam import sha256
from native_orientation import exact_roundtrip
from PIL import Image, ImageDraw
from probe_person_mask_overlap import content_digest


def resized(rgb, width, height):
    sh, sw = rgb.shape[:2]
    xs = np.clip(
        (np.arange(width, dtype=np.float64) + 0.5) * sw / width - 0.5, 0, sw - 1
    )
    ys = np.clip(
        (np.arange(height, dtype=np.float64) + 0.5) * sh / height - 0.5, 0, sh - 1
    )
    x0, y0 = xs.astype(np.int64), ys.astype(np.int64)
    x1, y1 = np.minimum(x0 + 1, sw - 1), np.minimum(y0 + 1, sh - 1)
    dx, dy = (xs - x0)[None, :, None], (ys - y0)[:, None, None]
    top = rgb[y0[:, None], x0] * (1 - dx) + rgb[y0[:, None], x1] * dx
    bottom = rgb[y1[:, None], x0] * (1 - dx) + rgb[y1[:, None], x1] * dx
    return np.floor(top * (1 - dy) + bottom * dy + 0.5).astype(np.float32)


def proxy(report_path):
    report = json.loads(report_path.read_text())
    selection = report["selectionInput"]
    data = (report_path.parent / "selection-proxy.rgb8").read_bytes()
    width, height = selection["proxySize"]
    if (
        content_digest(data) != selection["proxyDigest"]
        or len(data) != width * height * 3
    ):
        raise ValueError("Retained proxy identity mismatch")
    return report, np.frombuffer(data, dtype=np.uint8).reshape(height, width, 3)


def run(
    report_path, raw, reference_report, artifact, orientation_probe, orientation, output
):
    report, rgb = proxy(report_path)
    if content_digest(raw.read_bytes()) != report["source"]["original"]:
        raise ValueError("RAW identity differs from retained proxy")
    baseline, reference_rgb = proxy(reference_report)
    iw, ih = baseline["selectionInput"]["contentSize"]
    encoder = np.zeros((3, 1024, 1024), dtype=np.float32)
    encoder[:, :ih, :iw] = resized(reference_rgb, iw, ih).transpose(2, 0, 1)
    reference_bytes = (reference_report.parent / "selection-encoder.f32").read_bytes()
    if (
        content_digest(reference_bytes) != baseline["selectionInput"]["encoderDigest"]
        or encoder.astype("<f4").tobytes() != reference_bytes
    ):
        raise ValueError("Interpolation differs from actual Swift encoder tensor")
    pins = json.loads(
        Path(__file__).with_name("removal-models.generated.json").read_text()
    )
    pin = next(row for row in pins if row["id"] == "detector")
    if sha256(artifact) != pin["sha256"] or artifact.stat().st_size != pin["size"]:
        raise ValueError("Deployed detector artifact identity mismatch")
    if output.exists() or not 1 <= orientation <= 8:
        raise ValueError("Require a valid EXIF tag and fresh output")
    output.mkdir(parents=True)
    upright, roundtrip = exact_roundtrip(
        orientation_probe, rgb.astype(np.float32), orientation, output, "source"
    )
    # The shared RAW decoder, not a guessed portrait aspect, verifies the tag.
    verified = subprocess.run(
        [
            str(orientation_probe),
            str(output / "source-input.f32"),
            str(rgb.shape[1]),
            str(rgb.shape[0]),
            str(orientation),
            str(output / "raw-verified.f32"),
            "--raw",
            str(raw),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    raw_identity = json.loads(verified.stdout)["raw_identity"]
    if "blake3:" + raw_identity["original_blake3"] != report["source"]["original"]:
        raise ValueError("Orientation decoder source identity differs")
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    options.inter_op_num_threads = 1
    model = ort.InferenceSession(
        str(artifact), sess_options=options, providers=["CPUExecutionProvider"]
    )
    sizes = [report["source"][key] for key in ["width", "height"]]
    detector = resized(rgb, 640, 640)
    rotated_tensor, tensor_roundtrip = exact_roundtrip(
        orientation_probe, detector, orientation, output, "detector"
    )
    display_size = sizes[::-1] if orientation >= 5 else sizes
    arms = []
    for name, pixels, target, prepared in [
        ("native", rgb, sizes, detector),
        ("upright", upright, display_size, resized(upright, 640, 640)),
        ("upright_after_resize", upright, display_size, rotated_tensor),
    ]:
        tensor = prepared.transpose(2, 0, 1)[None] / np.float32(255)
        tensor.astype("<f4").tofile(output / f"{name}-detector.f32")
        labels, boxes, scores = model.run(
            None,
            {
                "images": tensor,
                "orig_target_sizes": np.asarray([target], dtype=np.int64),
            },
        )
        if (
            labels.shape != (1, 300)
            or boxes.shape != (1, 300, 4)
            or scores.shape != (1, 300)
        ):
            raise ValueError("Invalid deployed detector shape")
        if (
            not all(np.isfinite(v).all() for v in [boxes, scores])
            or not np.isin(labels, np.arange(80)).all()
        ):
            raise ValueError("Invalid deployed detector output")
        proposals = [
            {
                "class": int(labels[0, i]),
                "bounds": boxes[0, i].tolist(),
                "score": float(scores[0, i]),
            }
            for i in range(300)
        ]
        people = [
            person
            for person in proposals
            if person["class"] == 0 and person["score"] >= 0.5
        ]
        (output / f"{name}-detections.json").write_text(json.dumps(proposals) + "\n")
        image = Image.fromarray(pixels.astype(np.uint8))
        draw = ImageDraw.Draw(image)
        for person in people:
            x, y, right, bottom = person["bounds"]
            draw.rectangle(
                [
                    x * image.width / target[0],
                    y * image.height / target[1],
                    right * image.width / target[0],
                    bottom * image.height / target[1],
                ],
                outline="red",
                width=2,
            )
        image.save(output / f"{name}-people.png")
        arms.append(
            {
                "frame": name,
                "targetSize": target,
                "people": people,
                "tensorSHA256": sha256(output / f"{name}-detector.f32"),
            }
        )
        print(f"{name}: {len(people)} people >=0.5", flush=True)
    result = {
        "nativeReportSHA256": sha256(report_path),
        "rawSHA256": sha256(raw),
        "referenceReportSHA256": sha256(reference_report),
        "swiftEncoderReplayExact": True,
        "detectorPin": pin,
        "onnxruntime": ort.__version__,
        "provider": "CPUExecutionProvider",
        "sourceOrientation": orientation,
        "rawIdentity": raw_identity,
        "sourceRoundtrip": roundtrip,
        "detectorRoundtrip": tensor_roundtrip,
        "rotateBeforeVersusAfterResizeExact": bool(
            np.array_equal(rotated_tensor, resized(upright, 640, 640))
        ),
        "arms": arms,
        "releaseQualified": False,
        "scope": "Exact source-framed RAW proxy, shared EXIF permutation/RAW-tag verification and actual deployed RT-DETR on native and upright inputs. Interpolation replay matches production Swift encoder bits. No inverse detection-box/native mask integration, role/closure quality or device-performance claim.",
    }
    (output / "report.json").write_text(json.dumps(result, indent=2) + "\n")
    if content_digest(raw.read_bytes()) != report["source"]["original"]:
        raise ValueError("Original RAW changed during orientation probe")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in [
        "report_path",
        "raw",
        "reference_report",
        "artifact",
        "orientation_probe",
        "output",
    ]:
        parser.add_argument(name, type=Path)
    parser.add_argument("--orientation", type=int, required=True)
    run(**vars(parser.parse_args()))
