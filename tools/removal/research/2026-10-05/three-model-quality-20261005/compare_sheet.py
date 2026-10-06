from pathlib import Path

from PIL import Image, ImageDraw

r = Path(__file__).parent
items = [
    ("Source", None, None),
    ("LaMa 512", "512", "lama"),
    ("LaMa 768", "768", "lama"),
    ("LaMa 1024", "1024", "lama"),
    ("Klein 512 seed 0", "512", "klein-seed0"),
    ("Klein 512 seed 1", "512", "klein-seed1"),
    ("Klein 1024 seed 0", "1024", "klein-seed0"),
    ("Klein 1024 seed 1", "1024", "klein-seed1"),
    ("Qwen 512 seed 0", "512", "qwen-seed0"),
    ("Qwen 512 seed 1", "512", "qwen-seed1"),
]
for case in range(1, 6):
    p = r / f"case-{case}"
    out = Image.new("RGB", (5 * 384, 2 * 412), "#222")
    d = ImageDraw.Draw(out)
    for j, (label, size, model) in enumerate(items):
        path = (
            p / "source-native.png"
            if model is None
            else p / size / f"{model}-review.png"
        )
        x = (j % 5) * 384
        y = (j // 5) * 412
        d.text((x + 8, y + 8), label, fill="white")
        if path.exists():
            out.paste(Image.open(path).resize((384, 384)), (x, y + 28))
        else:
            d.text((x + 10, y + 50), "Pending", fill="white")
    out.save(r / f"case-{case}-comparison.jpg")
