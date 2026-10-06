import sys
from pathlib import Path

from PIL import Image, ImageDraw

r = Path(__file__).parent
for case in map(int, sys.argv[1:] or range(1, 5)):
    for seed in (0, 1):
        items = [
            ("Original", 512, "lama", "truth"),
            ("LaMa 768", 768, "lama", "removal"),
            ("Klein 512", 512, f"klein-seed{seed}", "removal"),
            ("Klein 1024", 1024, f"klein-seed{seed}", "removal"),
            ("Qwen 512", 512, f"qwen-seed{seed}", "removal"),
        ]
        grades = ["auto_ev+0_wb+0", "auto_ev+3_wb+1000", "neutral_ev-3_wb-1000"]
        out = Image.new("RGB", (5 * 384, 3 * 430), "#222")
        d = ImageDraw.Draw(out)
        for row, grade in enumerate(grades):
            for col, (label, side, model, variant) in enumerate(items):
                p = r / f"raw/case-{case}/{side}/{model}-grades/{grade}-{variant}.png"
                x, y = col * 384, row * 430
                d.text(
                    (x + 8, y + 5),
                    f"{label} / seed {seed}" if col > 1 else label,
                    fill="white",
                )
                d.text((x + 8, y + 23), grade, fill="white")
                if p.exists():
                    with Image.open(p) as im:
                        out.paste(
                            im.convert("RGB").resize(
                                (384, 384), Image.Resampling.LANCZOS
                            ),
                            (x, y + 46),
                        )
                else:
                    d.text((x + 10, y + 100), "PENDING", fill="white")
        out.save(r / f"raw-case-{case}-seed{seed}-review.jpg")
