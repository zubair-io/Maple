import json
from pathlib import Path

from PIL import Image, ImageDraw

r = Path(__file__).parent
boxes = [
    (1408, 4096, 1024),
    (6272, 3072, 2048),
    (5248, 2048, 3072),
    (5376, 896, 2048),
    (256, 1664, 1536),
]
labels = [
    "Outdoor: isolated blue-vest bystander",
    "Indoor: child on right (target pending review)",
    "Indoor: rear person, keep foreground pair",
    "Object: pink die and its shadow",
    "Portrait: green-clothed background pedestrian",
]
records = json.loads((r / "inventory.json").read_text())
sheet = Image.new("RGB", (1536, 1104), "white")
draw = ImageDraw.Draw(sheet)
for row, (x, y, size), label in zip(records, boxes, labels):
    i = row["id"]
    im = Image.open(row["preview"]).convert("RGB")
    assert im.size == (row["metadata"]["ImageWidth"], row["metadata"]["ImageHeight"])
    crop = im.crop((x, y, x + size, y + size))
    folder = r / f"case-{i}"
    folder.mkdir()
    crop.save(folder / "source.png")
    crop.resize((512, 512)).save(folder / "review-source.png")
    row.update(
        {
            "window": [x, y, size, size],
            "target": label,
            "source": "Full-resolution embedded camera JPEG; quality isolation only, not Maple RAW develop",
        }
    )
    ox = ((i - 1) % 3) * 512
    oy = ((i - 1) // 3) * 552
    sheet.paste(crop.resize((512, 512)), (ox, oy + 40))
    draw.text((ox + 8, oy + 12), f"{i}: {label}", fill="black")
(r / "cases.json").write_text(json.dumps(records, indent=2) + "\n")
sheet.save(r / "crop-review.png")
