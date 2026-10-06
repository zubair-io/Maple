import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).parent
case = int(sys.argv[1])
mode = sys.argv[2] if len(sys.argv) > 2 else "raw"
cov = sys.argv[3] if len(sys.argv) > 3 else "expanded"
grade = sys.argv[4] if len(sys.argv) > 4 else "auto_ev+0_wb+0"
base = ROOT.parent / ("raw" if mode != "camera" else "") / f"case-{case}"
root = ROOT / ("camera" if mode == "camera" else "raw") / f"case-{case}"
seed = 1 if mode == "camera" else 0
native = len(sys.argv) > 5 and sys.argv[5] == "native"


def display(p):
    im = Image.open(p).convert("RGB")
    if native:
        x = max(0, int(im.width * 0.5) - 256)
        y = max(0, int(im.height * 0.62) - 256)
        return im.crop((x, y, x + 512, y + 512))
    return im.resize((512, 512), Image.Resampling.LANCZOS)


canvas = Image.new("RGB", (2048, 1080), "#202820")
draw = ImageDraw.Draw(canvas)
for row, model in enumerate(["lama", f"qwen-seed{seed}"]):
    paths = (
        [
            base / "512/lama-grades" / f"{grade}-truth.png",
            base / f"512/{model}-grades" / f"{grade}-removal.png",
        ]
        if mode == "raw"
        else [base / "source-native.png", base / f"512/{model}-native.png"]
    )
    paths += [
        root / f"expand-{e}/512/{model}-{cov}-grades" / f"{grade}-removal.png"
        if mode == "raw"
        else root / f"expand-{e}/512/{model}-{cov}-native.png"
        for e in [8, 16]
    ]
    for col, (label, p) in enumerate(
        zip(["Original", f"{model} baseline", f"{model} +8", f"{model} +16"], paths)
    ):
        draw.text((col * 512 + 10, row * 540 + 8), label, fill="white")
        if not p.exists() and mode != "raw" and cov == "expanded":
            p = p.with_name(p.name.replace("-expanded-native", "-native"))
        if p.exists():
            canvas.paste(display(p), (col * 512, row * 540 + 28))
        else:
            draw.text((col * 512 + 10, row * 540 + 60), "pending", fill="white")
out = ROOT / "review"
out.mkdir(exist_ok=True)
path = out / f"{mode}-{case}-{cov}-{grade}{'-native' if native else ''}.jpg"
canvas.save(path, quality=95)
print(path)
