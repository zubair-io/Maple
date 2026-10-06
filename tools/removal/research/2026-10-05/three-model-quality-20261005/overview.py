from pathlib import Path

from PIL import Image, ImageDraw

r = Path(__file__).parent
out = Image.new("RGB", (4 * 384, 5 * 410), "#202020")
d = ImageDraw.Draw(out)
for i in range(1, 6):
    p = r / f"case-{i}"
    for j, (name, path) in enumerate(
        [("Source", p / "source-native.png")]
        + [(f"LaMa {s}", p / str(s) / "lama-review.png") for s in [512, 768, 1024]]
    ):
        if path.exists():
            out.paste(
                Image.open(path).resize((384, 384)), (j * 384, (i - 1) * 410 + 26)
            )
        d.text((j * 384 + 8, (i - 1) * 410 + 7), f"{i}: {name}", fill="white")
out.save(r / "lama-overview.jpg")
