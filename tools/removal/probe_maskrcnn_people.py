"""#3941: source-bound Mask R-CNN instance ownership research on RAW proxies.

Official COCO checkpoint, strict tensor-only load, unchanged TorchVision model
and shared Rust native mask mapping. No app/model admission or sidecar writes.
"""

import argparse
import hashlib
import json
import subprocess
import time
from pathlib import Path

import numpy as np
import torch
import torchvision
from PIL import Image, ImageDraw
from probe_person_mask_overlap import common_pixels, content_digest, read_mask
from torchvision.models.detection import maskrcnn_resnet50_fpn_v2

REVISION = "1f1a920d685d46dfbe187934b785b7ecb7a182f2"
WEIGHTS_SHA256 = "73cbd0190fcbe3ba339921fbce2c3a0b6bb9126c9a133c85e43a2a8e060a109e"
WEIGHTS_URL = (
    "https://download.pytorch.org/models/maskrcnn_resnet50_fpn_v2_coco-73cbd019.pth"
)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def source_pins(source):
    revision = subprocess.check_output(
        ["git", "-C", str(source), "rev-parse", "HEAD"], text=True
    ).strip()
    if revision != REVISION or subprocess.check_output(
        ["git", "-C", str(source), "diff", "HEAD", "--"]
    ):
        raise ValueError("TorchVision source differs from the pinned clean revision")
    if torchvision.version.git_version != REVISION:
        raise ValueError("Installed TorchVision has a different source revision")
    installed = Path(torchvision.__file__).parent
    names = ["models/resnet.py", "models/_utils.py", "models/_api.py", "_utils.py"]
    names += [
        str(path.relative_to(installed))
        for path in (installed / "models/detection").glob("*.py")
    ]
    names += [
        str(path.relative_to(installed)) for path in (installed / "ops").glob("*.py")
    ]
    pins = {}
    for name in sorted(names):
        expected = sha(source / "torchvision" / name)
        if sha(installed / name) != expected:
            raise ValueError(f"Installed TorchVision source changed: {name}")
        pins[name] = expected
    return {
        "revision": revision,
        "files": pins,
        "licenseSHA256": sha(source / "LICENSE"),
    }


def run(report_path, raw, source, weights, shared_probe, output):
    pins = source_pins(source)
    if sha(weights) != WEIGHTS_SHA256:
        raise ValueError("Official Mask R-CNN checkpoint identity mismatch")
    report = json.loads(report_path.read_text())
    original = raw.read_bytes()
    if content_digest(original) != report["source"]["original"]:
        raise ValueError("RAW differs from retained native proxy source")
    selection = report["selectionInput"]
    proxy_bytes = (report_path.parent / "selection-proxy.rgb8").read_bytes()
    width, height = selection["proxySize"]
    if (
        content_digest(proxy_bytes) != selection["proxyDigest"]
        or len(proxy_bytes) != width * height * 3
        or [width, height] != selection["contentSize"]
        or max(width, height) > 1024
    ):
        raise ValueError("Native selection proxy identity or content geometry mismatch")
    if output.exists():
        raise ValueError("Choose a fresh instance diagnostic output")
    torch.set_num_threads(4)
    model = maskrcnn_resnet50_fpn_v2(weights=None, weights_backbone=None)
    state = torch.load(weights, map_location="cpu", weights_only=True)
    model.load_state_dict(state, strict=True)
    model.eval()
    rgb = np.frombuffer(proxy_bytes, dtype=np.uint8).reshape(height, width, 3)
    tensor = torch.from_numpy(rgb.copy()).permute(2, 0, 1).float() / 255
    started = time.perf_counter()
    with torch.inference_mode():
        prediction = model([tensor])[0]
    elapsed = time.perf_counter() - started
    values = {name: value.numpy() for name, value in prediction.items()}
    count = len(values["scores"])
    if (
        values["boxes"].shape != (count, 4)
        or values["labels"].shape != (count,)
        or values["masks"].shape != (count, 1, height, width)
        or not all(np.isfinite(value).all() for value in values.values())
        or (values["masks"] < 0).any()
        or (values["masks"] > 1).any()
    ):
        raise ValueError("Invalid upstream instance output")
    output.mkdir(parents=True)
    np.savez(output / "predictions.npz", **values)
    size = [report["source"][key] for key in ["width", "height"]]
    retained = {
        record["id"]: read_mask(report_path.parent, record, size)
        for record in report.get("detectedMasks", [])
    }
    cases = []
    masks = []
    image = Image.fromarray(rgb.copy())
    draw = ImageDraw.Draw(image)
    for index in range(count):
        if values["labels"][index] != 1 or values["scores"][index] < 0.5:
            continue
        identifier = len(cases) + 1
        box = values["boxes"][index].tolist()
        x, y, right, bottom = box
        request = {
            "schema": 1,
            "source_width": size[0],
            "source_height": size[1],
            "window": {"x": 0, "y": 0, "width": size[0], "height": size[1]},
            "input_width": width,
            "input_height": height,
            "prompts": [
                {"position": [x / width, y / height], "label": 2},
                {"position": [right / width, bottom / height], "label": 3},
            ],
            "strokes": [],
        }
        request_path = output / f"request-{identifier}.json"
        request_path.write_text(json.dumps(request) + "\n")
        plane = np.full((1024, 1024), -0.5, dtype=np.float32)
        plane[:height, :width] = values["masks"][index, 0] - 0.5
        logits_path = output / f"logits-{identifier}.f32"
        np.tile(plane[None], (4, 1, 1)).astype("<f4").tofile(logits_path)
        scores_path = output / f"scores-{identifier}.json"
        scores_path.write_text("[1, 0, 0, 0]\n")
        mask_path = output / f"detected-{identifier}.mimf"
        subprocess.run(
            [
                str(shared_probe),
                str(request_path),
                str(logits_path),
                str(scores_path),
                str(mask_path),
            ],
            check=True,
            capture_output=True,
        )
        mask_bytes = mask_path.read_bytes()
        mask = read_mask(
            output,
            {
                "id": identifier,
                "file": mask_path.name,
                "digest": content_digest(mask_bytes),
            },
            size,
        )
        masks.append(mask)
        binary = values["masks"][index, 0] > 0.5
        Image.fromarray(binary.astype(np.uint8) * 255).save(
            output / f"mask-{identifier}.png"
        )
        color = tuple(
            int(v) for v in np.random.default_rng(identifier).integers(60, 256, 3)
        )
        draw.rectangle(box, outline=color, width=2)
        draw.text(
            (x + 2, y + 2),
            str(identifier),
            fill=color,
            stroke_width=1,
            stroke_fill="black",
        )
        cases.append(
            {
                "id": identifier,
                "modelIndex": index,
                "score": float(values["scores"][index]),
                "proxyXYXY": box,
                "sourceXYXY": [
                    x * size[0] / width,
                    y * size[1] / height,
                    right * size[0] / width,
                    bottom * size[1] / height,
                ],
                "proxyPixels": int(binary.sum()),
                "nativePixels": int(mask[1].sum()),
                "maskDigest": content_digest(mask_bytes),
                "commonWithProduction": {
                    str(key): common_pixels(mask, other)
                    for key, other in retained.items()
                },
            }
        )
        print(
            f"Instance {identifier}: score={values['scores'][index]:.4f}, pixels={binary.sum()}",
            flush=True,
        )
    image.save(output / "detector-boxes.png")
    result = {
        "source": pins,
        "weightsSHA256": WEIGHTS_SHA256,
        "weightsURL": WEIGHTS_URL,
        "weightsBytes": weights.stat().st_size,
        "stateTensorEntries": len(state),
        "torch": torch.__version__,
        "torchvision": torchvision.__version__,
        "device": "CPU",
        "threads": 4,
        "elapsedSeconds": elapsed,
        "nativeReportSHA256": sha(report_path),
        "rawSHA256": sha(raw),
        "selectionInput": selection,
        "sharedProbeSHA256": sha(shared_probe),
        "upstreamDefaultTransform": {
            "minSize": model.transform.min_size,
            "maxSize": model.transform.max_size,
            "mean": model.transform.image_mean,
            "std": model.transform.image_std,
        },
        "allOutputCount": count,
        "personScoreThreshold": 0.5,
        "maskThreshold": 0.5,
        "cases": cases,
        "overlaps": [
            {
                "first": a + 1,
                "second": b + 1,
                "commonPixels": common_pixels(first, second),
            }
            for a, first in enumerate(masks)
            for b, second in enumerate(masks)
            if a < b and common_pixels(first, second)
        ],
        "releaseQualified": False,
        "scope": "Unmodified official Mask R-CNN instance model on an exact native RAW selection proxy; native MIMF mapping is shared Rust. No ONNX/native adapter, independent ownership/closure labels, fill or device-performance qualification. TorchVision BSD source is not a determination of COCO weight distribution terms.",
    }
    (output / "report.json").write_text(json.dumps(result, indent=2) + "\n")
    if raw.read_bytes() != original:
        raise ValueError("Original RAW changed")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["report_path", "raw", "source", "weights", "shared_probe", "output"]:
        parser.add_argument(name, type=Path)
    run(**vars(parser.parse_args()))
