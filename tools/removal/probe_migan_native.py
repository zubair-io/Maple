"""Exercise pinned native MI-GAN graph candidates on real 1024px crops (#3941).

No resampling or image upload occurs. This probes shape, unchanged pixels,
determinism, runtime and texture diagnostics; it does not qualify scene-linear
reconstruction, people selection, or production device latency.
"""

import argparse
import json
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image

from build_migan_native import SOURCE_SHA256, sha256


def session(path: Path, provider: str) -> ort.InferenceSession:
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    options.inter_op_num_threads = 1
    options.log_severity_level = 3
    if provider not in ort.get_available_providers():
        raise ValueError(f"Requested provider is unavailable: {provider}")
    return ort.InferenceSession(str(path), sess_options=options, providers=[provider])


def infer(runtime: ort.InferenceSession, image: np.ndarray) -> tuple[np.ndarray, dict]:
    size = image.shape[0]
    pixels = image.transpose(2, 0, 1)[None].copy()
    mask = np.full((1, 1, size, size), 255, dtype=np.uint8)
    center = size // 2
    mask[:, :, center - 100 : center + 100, center - 100 : center + 100] = 0
    times = []
    results = []
    for _ in range(3):
        started = time.perf_counter()
        result = runtime.run(None, {"image": pixels, "mask": mask})[0]
        times.append((time.perf_counter() - started) * 1000)
        if result.shape != pixels.shape or result.dtype != np.uint8:
            raise ValueError("Model output does not match the native uint8 contract")
        results.append(result)
    if not all(np.array_equal(results[0], result) for result in results[1:]):
        raise ValueError("Pinned reconstruction is nondeterministic on this provider")
    known = np.repeat(mask == 255, 3, axis=1)
    outside_error = int(
        np.abs(results[0].astype(int) - pixels.astype(int))[known].max()
    )
    if outside_error != 0:
        raise ValueError("Model changed known source pixels")
    output = results[0][0].transpose(1, 2, 0)
    hole = output[center - 98 : center + 98, center - 98 : center + 98].astype(float)
    truth = image[center - 98 : center + 98, center - 98 : center + 98].astype(float)

    def laplacian_energy(values: np.ndarray) -> float:
        luma = values.mean(axis=2)
        lap = (
            4 * luma[1:-1, 1:-1]
            - luma[:-2, 1:-1]
            - luma[2:, 1:-1]
            - luma[1:-1, :-2]
            - luma[1:-1, 2:]
        )
        return float(np.abs(lap).mean())

    energy = laplacian_energy(truth)
    return output, {
        "size": size,
        "hole_size": 200,
        "elapsed_ms": times,
        "providers": runtime.get_providers(),
        "outside_mask_max_error": outside_error,
        "deterministic_three_runs": True,
        "masked_laplacian_ratio_reference": laplacian_energy(hole) / energy
        if energy
        else None,
        "texture_metric_is_diagnostic_only": True,
    }


def probe(
    source: Path, directory: Path, images: list[Path], output: Path, provider: str
) -> dict:
    if sha256(source) != SOURCE_SHA256:
        raise ValueError("Upstream model checksum mismatch")
    candidates = {}
    for size in (512, 1024):
        path = directory / f"migan-native-{size}.onnx"
        manifest = json.loads(path.with_suffix(".json").read_text())
        if manifest["artifact_sha256"] != sha256(path):
            raise ValueError("Built candidate checksum mismatch")
        candidates[size] = session(path, provider)
    upstream = session(source, provider)
    output.mkdir(parents=True, exist_ok=True)
    cases = []
    for path in images:
        with Image.open(path) as opened:
            if opened.size != (1024, 1024):
                raise ValueError(
                    f"Expected a native 1024 square crop, without resizing: {path}"
                )
            image = np.asarray(opened.convert("RGB"))
        central = image[256:768, 256:768].copy()
        baseline, _ = infer(upstream, central)
        rebuilt, small = infer(candidates[512], central)
        if not np.array_equal(baseline, rebuilt):
            raise ValueError("Static 512 build differs from the pinned original")
        result, large = infer(candidates[1024], image)
        Image.fromarray(result).save(output / f"{path.stem}-native-1024.png")
        Image.fromarray(rebuilt).save(output / f"{path.stem}-native-512.png")
        cases.append(
            {
                "image": path.name,
                "image_sha256": sha256(path),
                "static_512_matches_upstream": True,
                "512": small,
                "1024": large,
            }
        )
    report = {
        "onnxruntime": ort.__version__,
        "requested_provider": provider,
        "cases": cases,
        "qualification": "execution probe only; no scene-linear reconstruction or device release gate",
    }
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("upstream", type=Path)
    parser.add_argument("native_models", type=Path)
    parser.add_argument("output_directory", type=Path)
    parser.add_argument("images", type=Path, nargs="+")
    parser.add_argument(
        "--provider",
        choices=("CPUExecutionProvider", "CoreMLExecutionProvider"),
        default="CPUExecutionProvider",
    )
    args = parser.parse_args()
    print(
        json.dumps(
            probe(
                args.upstream,
                args.native_models,
                args.images,
                args.output_directory,
                args.provider,
            ),
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
