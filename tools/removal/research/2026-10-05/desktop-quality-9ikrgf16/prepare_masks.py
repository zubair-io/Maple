import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

r = Path(__file__).parent
polys = {
    1: [
        (237, 109),
        (275, 110),
        (288, 145),
        (301, 180),
        (310, 250),
        (294, 290),
        (281, 327),
        (281, 368),
        (217, 371),
        (210, 310),
        (205, 280),
        (191, 259),
        (196, 204),
        (205, 166),
        (234, 146),
    ],
    2: [
        (245, 116),
        (285, 118),
        (296, 147),
        (296, 171),
        (310, 188),
        (326, 254),
        (325, 300),
        (311, 300),
        (318, 351),
        (327, 421),
        (280, 423),
        (266, 374),
        (271, 419),
        (226, 422),
        (226, 348),
        (223, 312),
        (215, 314),
        (187, 302),
        (188, 278),
        (200, 228),
        (214, 188),
        (233, 169),
        (234, 140),
    ],
    3: [
        (240, 64),
        (274, 65),
        (289, 92),
        (290, 110),
        (308, 126),
        (318, 157),
        (310, 182),
        (304, 201),
        (305, 262),
        (315, 330),
        (301, 343),
        (282, 346),
        (282, 388),
        (273, 421),
        (235, 425),
        (213, 407),
        (208, 363),
        (205, 346),
        (180, 336),
        (181, 303),
        (193, 228),
        (196, 186),
        (191, 175),
        (194, 151),
        (204, 125),
        (232, 110),
    ],
    4: [
        (119, 191),
        (222, 145),
        (274, 169),
        (368, 266),
        (370, 305),
        (209, 397),
        (151, 397),
        (125, 354),
        (108, 280),
    ],
    5: [
        (242, 104),
        (277, 106),
        (292, 125),
        (289, 147),
        (285, 158),
        (297, 177),
        (314, 189),
        (326, 210),
        (314, 230),
        (283, 237),
        (282, 252),
        (300, 293),
        (304, 327),
        (290, 349),
        (285, 361),
        (301, 391),
        (308, 425),
        (274, 427),
        (252, 368),
        (229, 328),
        (218, 347),
        (202, 387),
        (191, 426),
        (150, 428),
        (155, 380),
        (177, 336),
        (188, 301),
        (189, 267),
        (192, 236),
        (184, 233),
        (169, 251),
        (158, 270),
        (134, 263),
        (139, 239),
        (156, 208),
        (176, 178),
        (187, 158),
        (224, 142),
        (231, 122),
    ],
}
protection = {
    5: [
        [
            (363, 299),
            (407, 278),
            (478, 232),
            (512, 219),
            (512, 512),
            (378, 512),
            (357, 439),
            (341, 385),
            (341, 345),
        ],
        [(168, 493), (240, 388), (359, 302), (339, 338), (239, 440)],
    ]
}
sheet = Image.new("RGB", (1536, 1104), "white")
d = ImageDraw.Draw(sheet)
for c in json.loads((r / "cases.json").read_text()):
    i = c["id"]
    p = r / f"case-{i}"
    src = Image.open(p / "source.png").convert("RGB")
    size = src.width
    mask = Image.new("L", src.size)
    draw = ImageDraw.Draw(mask)
    draw.polygon(
        [(round(x * size / 512), round(y * size / 512)) for x, y in polys[i]], fill=255
    )
    if i in [2, 3]:
        draw.ellipse(
            tuple(
                round(v * size / 512)
                for v in ([213, 397, 336, 440] if i == 2 else [209, 397, 294, 445])
            ),
            fill=255,
        )
    protected = Image.new("L", src.size)
    if i in protection:
        for poly in protection[i]:
            ImageDraw.Draw(protected).polygon(
                [(round(x * size / 512), round(y * size / 512)) for x, y in poly],
                fill=255,
            )
    a = np.array(mask)
    keep = np.array(protected) > 0
    a[keep] = 0
    mask = Image.fromarray(a)
    hole = np.array(mask.filter(ImageFilter.MaxFilter(25)))
    hole[keep] = 0
    mask.save(p / "intent.png")
    Image.fromarray(hole).save(p / "hole.png")
    protected.save(p / "protected.png")
    overlay = np.array(src).copy()
    selected = a > 0
    overlay[selected] = (
        overlay[selected] * 0.5 + np.array([255, 30, 30]) * 0.5
    ).astype("uint8")
    overlay[keep] = (overlay[keep] * 0.7 + np.array([40, 220, 60]) * 0.3).astype(
        "uint8"
    )
    out = Image.fromarray(overlay)
    out.save(p / "mask-review.png")
    ox = ((i - 1) % 3) * 512
    oy = ((i - 1) // 3) * 552
    sheet.paste(out.resize((512, 512)), (ox, oy + 40))
    d.text((ox + 8, oy + 12), f"Case {i}: red=remove; green=protect", fill="black")
(r / "mask-annotations.json").write_text(
    json.dumps(
        {
            "coordinateSystem": "512x512 crop review scaled to native pixels",
            "reviewer": "assistant visual inspection; not human ground truth",
            "polygons": polys,
            "protection": protection,
            "holeDilationSourcePixels": 12,
        },
        indent=2,
    )
    + "\n"
)
sheet.save(r / "mask-review.png")
