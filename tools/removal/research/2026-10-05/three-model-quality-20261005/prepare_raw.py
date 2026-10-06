import json
import shutil
import struct
import subprocess
from pathlib import Path

import numpy as np
from common import ROOT
from PIL import Image

probe = ROOT.parent / "desktop-quality-target/release/examples/removal-scene-probe"
e = ROOT.parent / "desktop-quality-9ikrgf16"
m = ROOT.parent / "moebius-quality-yzitv43p"
rr = ROOT / "raw"
rr.mkdir(exist_ok=True)


def mimf(image, path, c):
    a = np.array(image) > 0
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


cases = json.loads((ROOT / "cases.json").read_text())
for c in cases:
    i = c["id"]
    p = rr / f"case-{i}"
    p.mkdir(exist_ok=True)
    ctx = p / "context"
    ctx.mkdir(exist_ok=True)
    x, y, n, _ = c["window"]
    prior = {
        1: e / "case-1/maple-sdr",
        2: e / "case-2/maple-sdr-plus2",
        4: m / "raw-case-4",
    }.get(i)
    if not (ctx / "context.json").exists():
        if prior:
            for name in ["context.json", "scene.f32", "input.f32", "input.png"]:
                shutil.copy2(prior / name, ctx / name)
        else:
            args = [
                str(probe),
                "encode",
                c["raw"],
                str(x),
                str(y),
                str(ctx),
                "--fixed-sdr",
                "--research-side",
                str(n),
                "--model-exposure-ev",
                str(2 if i == 3 else 0),
            ]
            with (p / "encode.log").open("w") as log:
                subprocess.run(args, stdout=log, stderr=subprocess.STDOUT, check=True)
    masksource = Path(c["canonicalMaskSource"])
    cov = np.fromfile(masksource / "coverage.f32", dtype="<f4").reshape(512, 512)
    intent = Image.fromarray((cov == 1).astype("uint8") * 255).resize(
        (n, n), Image.Resampling.NEAREST
    )
    protected = Image.open(ROOT / f"case-{i}" / "protected-native.png")
    mimf(intent, p / "intent-source.mimf", c)
    mimf(protected, p / "protected-source.mimf", c)
    with (p / "masks.log").open("w") as log:
        subprocess.run(
            [
                str(probe),
                "masks",
                str(ctx),
                str(p / "intent-source.mimf"),
                "--protected",
                str(p / "protected-source.mimf"),
                "--hole-radius",
                "8",
                "--fringe-radius",
                "4",
            ],
            stdout=log,
            stderr=subprocess.STDOUT,
            check=True,
        )
    # Canonical shared RAW compositor coverage, identical across models/scales.
    masks = np.fromfile(ctx / "masks.f32", dtype="<f4").reshape(2, n, n)
    masks[1].tofile(p / "coverage-native.f32")
    src = Image.open(ctx / "input.png").convert("RGB")
    src.save(p / "source-native.png")
    protected.save(p / "protected-native.png")
    # Keep model erasure context from the frozen reviewed selection expansion.
    hole = Image.open(ROOT / f"case-{i}" / "hole-native.png")
    for side in [512, 768, 1024]:
        target = p / str(side)
        target.mkdir(exist_ok=True)
        src.resize((side, side), Image.Resampling.LANCZOS).save(target / "source.png")
        hole.resize((side, side), Image.Resampling.NEAREST).save(target / "hole.png")
        np.array(
            Image.fromarray(masks[1]).resize((side, side), Image.Resampling.BILINEAR),
            dtype="<f4",
        ).tofile(target / "coverage.f32")
    c["rawContext"] = str(ctx)
    c["rawModelInput"] = (
        "fixed AgX/sRGB research encode, quantized u8 equally for all models; +2EV model plate for indoor cases, reversed on decode"
    )
    print("RAW prepared", i, flush=True)
(rr / "cases.json").write_text(json.dumps(cases, indent=2))
