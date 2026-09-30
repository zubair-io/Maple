"""Rebuild MapleUI's offline Rounded outlines from the pinned Google source."""

import json
from pathlib import Path
from urllib.request import urlopen

from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

REVISION = "bd8cb85bd4bad964fe6918f79665bb40c3a8efef"
BASE = f"https://raw.githubusercontent.com/google/material-design-icons/{REVISION}"
FONT = "MaterialSymbolsRounded%5BFILL%2CGRAD%2Copsz%2Cwght%5D"
DESTINATION = (
    Path(__file__).resolve().parents[1]
    / "src/apple/Packages/MapleUI/Sources/MapleUI/Resources/MaterialSymbols"
)


def upstream(path):
    with urlopen(f"{BASE}/{path}", timeout=60) as response:
        return response.read()


def main():
    from io import BytesIO

    destination = DESTINATION
    destination.mkdir(parents=True, exist_ok=True)
    font = TTFont(BytesIO(upstream(f"variablefont/{FONT}.ttf")), recalcTimestamp=False)
    instantiateVariableFont(
        font, {"FILL": 0, "GRAD": 0, "opsz": 24, "wght": 400}, inplace=True
    )
    # MuiIcon consumes outlines by glyph ID; text-shaping tables are unused.
    for table in ["GSUB", "GPOS"]:
        if table in font:
            del font[table]
    cmap = font.getBestCmap()
    codepoints = upstream(f"variablefont/{FONT}.codepoints").decode().splitlines()
    glyphs = {
        name: font.getGlyphID(cmap[int(codepoint, 16)])
        for name, codepoint in (line.split() for line in codepoints)
    }
    font.save(destination / "Rounded.ttf")
    (destination / "glyphs.json").write_text(
        json.dumps(glyphs, sort_keys=True, indent=2) + "\n"
    )
    (destination / "LICENSE.txt").write_bytes(upstream("LICENSE"))
    print(f"Bundled {len(glyphs)} Rounded names from {REVISION}")


if __name__ == "__main__":
    main()
