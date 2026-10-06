import hashlib
import json
import shutil
import struct
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy.ndimage import distance_transform_edt

ROOT = Path(__file__).parent
BASE = ROOT.parent
CACHE = BASE.parent
probe = CACHE / "desktop-quality-target/release/examples/removal-scene-probe"
cases = json.loads((BASE / "cases.json").read_text())
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()


def mimf(a, path, c):
    ys, xs = np.where(a)
    box = (
        (int(xs.min()), int(ys.min()), int(xs.max() + 1), int(ys.max() + 1))
        if len(xs)
        else (0, 0, 1, 1)
    )
    pixels = a[box[1] : box[3], box[0] : box[2]]
    x, y, _, _ = c["window"]
    sw = c["metadata"]["ImageWidth"]
    sh = c["metadata"]["ImageHeight"]
    path.write_bytes(
        b"MIMF\x01\0\0\0"
        + struct.pack(
            "<6I", sw, sh, x + box[0], y + box[1], pixels.shape[1], pixels.shape[0]
        )
        + np.packbits(pixels.flatten(), bitorder="little").tobytes()
    )


def decode_mimf(path, c):
    b = path.read_bytes()
    assert b[:8] == b"MIMF\x01\0\0\0"
    _sw, _sh, x, y, w, h = struct.unpack("<6I", b[8:32])
    pixels = (
        np.unpackbits(np.frombuffer(b[32:], dtype="uint8"), bitorder="little")[: w * h]
        .reshape(h, w)
        .astype(bool)
    )
    x0, y0, n, _ = c["window"]
    a = np.zeros((n, n), bool)
    a[y - y0 : y - y0 + h, x - x0 : x - x0 + w] = pixels
    return a


jobs = []
for mode, selected, seed in [("raw", cases, 0), ("camera", [cases[0]], 1)]:
    for c in selected:
        i = c["id"]
        n = c["window"][2]
        base = (BASE / "raw" if mode == "raw" else BASE) / f"case-{i}"
        protected = np.asarray(Image.open(base / "protected-native.png")) > 0
        if i == 3:
            guard = Image.new("1", (512, 512))
            ImageDraw.Draw(guard).polygon(
                [
                    (0, 0),
                    (90, 0),
                    (90, 48),
                    (120, 84),
                    (130, 140),
                    (123, 190),
                    (124, 224),
                    (145, 250),
                    (158, 285),
                    (156, 317),
                    (162, 358),
                    (174, 420),
                    (184, 455),
                    (183, 491),
                    (179, 512),
                    (0, 512),
                ],
                fill=1,
            )
            protected = protected | np.asarray(
                guard.resize((n, n), Image.Resampling.NEAREST)
            )
        baseHole = np.asarray(Image.open(base / "512/hole.png")) > 0
        protected512 = (
            np.asarray(
                Image.fromarray(protected).resize((512, 512), Image.Resampling.NEAREST)
            )
            > 0
        )
        nativeCov = np.fromfile(base / "coverage-native.f32", dtype="<f4").reshape(n, n)
        assert not np.any(nativeCov[protected] > 0), (
            "Keep guard must not change baseline replacement area"
        )
        intent = (
            decode_mimf(base / "intent-source.mimf", c)
            if mode == "raw"
            else nativeCov == 1
        )
        distance = distance_transform_edt(~intent)
        for expansion in [8, 16]:
            folder = ROOT / mode / f"case-{i}" / f"expand-{expansion}"
            p = folder / "512"
            p.mkdir(parents=True, exist_ok=True)
            for name in ["source-native.png", "protected-native.png"]:
                shutil.copy2(base / name, folder / name)
            Image.fromarray(protected.astype("uint8") * 255).save(
                folder / "protected-native.png"
            )
            mimf(protected, folder / "protected-source.mimf", c)
            shutil.copy2(
                base / "coverage-native.f32", folder / "coverage-original-native.f32"
            )
            shutil.copy2(base / "512/source.png", p / "source.png")
            hole = (distance_transform_edt(~baseHole) <= expansion) & ~protected512
            assert not np.any(hole & protected512)
            assert np.all(hole[baseHole & ~protected512])
            Image.fromarray(hole.astype("uint8") * 255).save(p / "hole.png")
            expandedIntent = (distance <= expansion * n / 512) & ~protected
            if mode == "raw":
                ctx = folder / "context"
                shutil.copytree(base / "context", ctx, dirs_exist_ok=True)
                mimf(expandedIntent, folder / "expanded-intent.mimf", c)
                with (folder / "prepare-masks.log").open("w") as log:
                    subprocess.run(
                        [
                            str(probe),
                            "masks",
                            str(ctx),
                            str(folder / "expanded-intent.mimf"),
                            "--protected",
                            str(folder / "protected-source.mimf"),
                            "--hole-radius",
                            "8",
                            "--fringe-radius",
                            "4",
                        ],
                        stdout=log,
                        stderr=subprocess.STDOUT,
                        check=True,
                    )
                coverage = np.fromfile(ctx / "masks.f32", dtype="<f4").reshape(2, n, n)[
                    1
                ]
            else:
                # Preserve the previous 2 model-pixel linear feather, shifted out by dilation.
                signed = distance_transform_edt(~(nativeCov == 1)) * 512 / n - expansion
                coverage = np.clip(1 - signed / 2, 0, 1).astype("float32")
                coverage[protected] = 0
            assert np.all(coverage[protected] == 0)
            assert np.all(coverage >= nativeCov - 1e-5)
            coverage.astype("<f4").tofile(folder / "coverage-native.f32")
            np.asarray(
                Image.fromarray(coverage).resize((512, 512), Image.Resampling.BILINEAR),
                dtype="<f4",
            ).tofile(p / "coverage.f32")
            Image.fromarray(np.round(coverage * 255).astype("uint8")).save(
                folder / "coverage-native.png"
            )
            src = np.array(Image.open(p / "source.png").convert("RGB")).astype(
                "float32"
            )
            a = hole[:, :, None] * 0.38
            overlay = (
                (src * (1 - a) + np.array([240, 70, 55]) * a)
                .clip(0, 255)
                .astype("uint8")
            )
            overlay[protected512] = (
                overlay[protected512] * 0.6 + np.array([0, 180, 130]) * 0.4
            ).astype("uint8")
            Image.fromarray(overlay).save(folder / "mask-review.png")
            row = {
                "mode": mode,
                "case": i,
                "expansionModelPixels": expansion,
                "expansionSourcePixels": expansion * n / 512,
                "modelSide": 512,
                "seed": seed,
                "folder": str(p),
                "baselineFolder": str(base / "512"),
                "baselineContext": str(base / "context") if mode == "raw" else None,
                "raw": c["raw"],
                "nativeSide": n,
                "inputSha256": sha(p / "source.png"),
                "baselineInputSha256": sha(base / "512/source.png"),
                "holeSha256": sha(p / "hole.png"),
                "protectedPixels": int(protected.sum()),
                "newModelMaskPixels": int(hole.sum()),
                "baselineModelMaskPixels": int(baseHole.sum()),
                "replacementPixels": int((coverage > 0).sum()),
                "baselineReplacementPixels": int((nativeCov > 0).sum()),
            }
            assert row["inputSha256"] == row["baselineInputSha256"]
            (folder / "geometry.json").write_text(json.dumps(row, indent=2))
            jobs.append(row)
            print(mode, i, expansion, flush=True)
(ROOT / "jobs.json").write_text(json.dumps(jobs, indent=2))
for name in ["common.py", "qwen-manifest.json"]:
    shutil.copy2(BASE / name, ROOT / name)
(ROOT / "protocol.json").write_text(
    json.dumps(
        {
            "issue": 3941,
            "models": ["Big-LaMa CPU float32", "Qwen Image Edit 2511 q8 MLX GPU"],
            "scope": "5 RAW model-input cases, seed0; photographic case1 seed1 retained as the known person-regeneration failure control",
            "resolution": 512,
            "maskExpansionsModelPixels": [8, 16],
            "constant": "Exact same source PNG bytes, crop, checkpoint, prompt, steps, guidance, and matched seed as previous baseline",
            "composites": ["expanded replacement area", "original replacement area"],
            "protection": "Original protection plus a conservative foreground keep-region on case3, disjoint from baseline replacement coverage. Protection removed from expanded inference hole and both compositor coverages.",
            "nativeFeather": "RAW shared 4 source-pixel smoothstep unchanged; camera original 2 model-pixel linear feather unchanged",
            "notTested": "No new model-resolution comparison, prompt tuning, context expansion, or performance optimization",
            "qualification": "Local experiment only; case5 calibrated RAW/WB qualification still unavailable under #4283",
            "plannedNewGenerations": 24,
            "baseline": "../protocol.json",
        },
        indent=2,
    )
)
