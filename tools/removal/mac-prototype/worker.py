"""#4323 standalone Mac experiment. Never writes to RAWs or adjacent XMPs."""

import hashlib
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
from geometry import expanded_masks, masks, mimf, orient, window
from PIL import Image

CHILD = None


def write_json(path, value):
    path = Path(path)
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(value, indent=2))
    temp.replace(path)


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def cancel(_signal, _frame):
    if CHILD is not None and CHILD.poll() is None:
        os.killpg(CHILD.pid, signal.SIGTERM)
        try:
            CHILD.wait(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(CHILD.pid, signal.SIGKILL)
            CHILD.wait()
    raise SystemExit(130)


def run(args, folder, message):
    global CHILD
    status(folder, message)
    progress_file = folder / "model-progress.json"
    progress_file.unlink(missing_ok=True)
    with (folder / "worker.log").open("ab") as log:
        CHILD = subprocess.Popen(
            [str(a) for a in args], stdout=log, stderr=log, start_new_session=True
        )
        last = None
        while CHILD.poll() is None:
            if progress_file.exists():
                progress = json.loads(progress_file.read_text())["message"]
                if progress != last:
                    status(folder, progress)
                    last = progress
            time.sleep(0.25)
        result = CHILD.returncode
        CHILD = None
    if result:
        tail = (folder / "worker.log").read_text(errors="replace")[-1800:]
        raise RuntimeError(f"{message} failed ({result}). {tail}")


def status(folder, message, **extra):
    write_json(folder / "status.json", {"message": message, **extra})


def png(path, values):
    Image.fromarray(np.floor(values * 255 + 0.5).clip(0, 255).astype("uint8")).save(
        path
    )


def resize_float(values, side):
    return np.stack(
        [
            np.asarray(
                Image.fromarray(values[:, :, c]).resize(
                    (side, side), Image.Resampling.BILINEAR
                )
            )
            for c in range(3)
        ],
        axis=-1,
    ).astype("float32")


def refine_candidate(kind, job, config, metadata, context):
    sys.path.insert(0, config["removalTools"])
    from guided_native_patches import refine

    side = context["window"]["width"]
    source = (
        np.asarray(
            Image.open(job / "context/input.png").convert("RGB"), dtype="float32"
        )
        / 255
    )
    coarse = np.fromfile(job / f"{kind}-coarse.f32", dtype="<f4").reshape(512, 512, 3)
    # Model saw upright pixels; return its prediction to native coordinates.
    coarse = np.stack(
        [
            np.asarray(
                orient(Image.fromarray(coarse[:, :, c]), metadata["orientation"], True)
            )
            for c in range(3)
        ],
        axis=-1,
    )
    native = resize_float(coarse, side)
    coverage = np.fromfile(job / "context/masks.f32", dtype="<f4").reshape(
        2, side, side
    )[1]
    protected = np.asarray(Image.open(job / "protected.png")) > 0
    guide = source * (1 - coverage[:, :, None]) + native * coverage[:, :, None]
    status(job, f"{kind.title()}: transferring native texture…")
    started = time.perf_counter()
    prediction, report = refine(source, (coverage > 0) | protected, guide)
    if not np.isfinite(prediction).all():
        raise ValueError("Nonfinite texture-transfer result")
    prediction = prediction.clip(0, 1)
    np.ascontiguousarray(prediction.transpose(2, 0, 1), dtype="<f4").tofile(
        job / f"{kind}-prediction.f32"
    )
    composed = source * (1 - coverage[:, :, None]) + prediction * coverage[:, :, None]
    if not np.array_equal(
        composed[coverage == 0], source[coverage == 0]
    ) or not np.array_equal(composed[protected], source[protected]):
        raise ValueError("Texture transfer altered protected or outside-mask pixels")
    png(job / f"{kind}-plate.png", composed)
    report.update(
        seconds=time.perf_counter() - started,
        outsideChanged=0,
        protectedChanged=0,
        coarseSha256=digest(job / f"{kind}-coarse.f32"),
        nativeSide=side,
        releaseQualified=False,
    )
    write_json(job / f"{kind}-texture.json", report)
    bake = job / f"{kind}-grades"
    run(
        [
            config["probe"],
            "bake",
            metadata["raw"],
            job / "context",
            job / f"{kind}-prediction.f32",
            bake,
        ],
        job,
        f"{kind.title()}: checking RAW exposure and white balance…",
    )
    check_grades(bake, coverage, protected)
    # UI assets are upright and explicitly tagged sRGB by the native image loader.
    display = job / kind
    display.mkdir()
    for path in bake.glob("*.png"):
        orient(Image.open(path), metadata["orientation"]).save(display / path.name)
    return {
        "id": kind,
        "folder": str(display),
        "label": "LaMa" if kind == "lama" else "Qwen",
        "report": str(job / f"{kind}-texture.json"),
    }


def check_grades(folder, coverage, protected):
    checked = 0
    for truth_path in folder.glob("*-truth.png"):
        truth = np.asarray(Image.open(truth_path))
        result = np.asarray(
            Image.open(str(truth_path).replace("-truth.png", "-removal.png"))
        )
        if not np.array_equal(
            truth[coverage == 0], result[coverage == 0]
        ) or not np.array_equal(truth[protected], result[protected]):
            raise ValueError("RAW grade changed protected or outside-mask pixels")
        checked += 1
    if checked != 18:
        raise ValueError("RAW grade set incomplete")
    write_json(
        folder / "preservation.json",
        {"gradesChecked": checked, "outsideChanged": 0, "protectedChanged": 0},
    )


def generate(job, config):
    request = json.loads((job / "request.json").read_text())
    metadata = json.loads(Path(request["source"]).read_text())
    original_sha256 = digest(metadata["raw"])
    selection, protected = masks(request["strokes"], metadata)
    x, y, side = window(selection)
    selection = selection[y : y + side, x : x + side]
    protected = protected[y : y + side, x : x + side]
    expanded, hole = expanded_masks(selection, protected, side)
    ctx = job / "context"
    run(
        [
            config["probe"],
            "encode",
            metadata["raw"],
            x,
            y,
            ctx,
            "--fixed-sdr",
            "--research-side",
            side,
        ],
        job,
        "Preparing the native RAW context…",
    )
    context = json.loads((ctx / "context.json").read_text())
    if context["original"] != metadata["original"]:
        raise ValueError("RAW changed since opening. Open it again.")
    if (context["source_width"], context["source_height"]) != (
        metadata["width"],
        metadata["height"],
    ):
        raise ValueError("RAW selection geometry changed")
    mimf(expanded, job / "intent.mimf", metadata, x, y)
    mimf(protected, job / "protected.mimf", metadata, x, y)
    Image.fromarray(protected.astype("uint8") * 255).save(job / "protected.png")
    run(
        [
            config["probe"],
            "masks",
            ctx,
            job / "intent.mimf",
            "--protected",
            job / "protected.mimf",
            "--hole-radius",
            8,
            "--fringe-radius",
            4,
        ],
        job,
        "Preparing the expanded selection…",
    )
    native_source = Image.open(ctx / "input.png").convert("RGB")
    orient(native_source, metadata["orientation"]).resize(
        (512, 512), Image.Resampling.LANCZOS
    ).save(job / "source.png")
    orient(Image.fromarray(hole.astype("uint8") * 255), metadata["orientation"]).save(
        job / "hole.png"
    )
    manifest = {
        "source": metadata,
        "context": context,
        "candidates": [],
        "errors": [],
        "complete": False,
        "job": str(job),
    }
    write_json(job / "result.json", manifest)
    for kind in ("lama", "qwen"):
        try:
            interpreter = (
                config["lamaPython"] if kind == "lama" else config["qwenPython"]
            )
            run(
                [
                    interpreter,
                    Path(__file__).with_name("model_runner.py"),
                    kind,
                    job,
                    config["configPath"],
                ],
                job,
                f"Starting {kind.title()}…",
            )
            candidate = refine_candidate(kind, job, config, metadata, context)
            manifest["candidates"].append(candidate)
        except (ValueError, RuntimeError, OSError, subprocess.SubprocessError) as error:
            manifest["errors"].append({"model": kind, "message": str(error)})
        write_json(job / "result.json", manifest)
    if digest(metadata["raw"]) != original_sha256:
        raise ValueError("RAW changed while generating; results cannot be trusted.")
    manifest["complete"] = True
    write_json(job / "result.json", manifest)
    status(
        job,
        "Both candidates are ready."
        if len(manifest["candidates"]) == 2
        else "Generation finished with errors. See the model details.",
        complete=True,
    )


def main():
    command, folder, config_path = sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3])
    config = json.loads(config_path.read_text())
    config["configPath"] = str(config_path)
    signal.signal(signal.SIGTERM, cancel)
    signal.signal(signal.SIGINT, cancel)
    try:
        if command == "open":
            request = json.loads((folder / "request.json").read_text())
            run(
                [config["probe"], "preview", request["raw"], folder],
                folder,
                "Opening RAW photo…",
            )
            status(folder, "Paint the object to remove.", complete=True)
        elif command == "generate":
            generate(folder, config)
        else:
            raise ValueError("Unknown research command")
    except Exception as error:
        status(folder, str(error), error=True, complete=True)
        raise


if __name__ == "__main__":
    main()
