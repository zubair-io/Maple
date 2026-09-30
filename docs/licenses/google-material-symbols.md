# Google Material Symbols Rounded

MapleUI bundles Google's Material Symbols Rounded under the Apache License 2.0.
Copyright Google LLC. The complete upstream license is included with the
package resources at
`src/apple/Packages/MapleUI/Sources/MapleUI/Resources/MaterialSymbols/LICENSE.txt`.

Source: [Google Material Design Icons](https://github.com/google/material-design-icons),
revision `bd8cb85bd4bad964fe6918f79665bb40c3a8efef`.

`Rounded.ttf` and `RoundedFilled.ttf` are static instances of the upstream variable font: weight 400,
optical size 24, grade 0, with fill 0 and 1 respectively. The unused GSUB/GPOS shaping tables are removed.
`glyphs.json` maps Google's canonical names directly to glyph IDs in that same
font, including names whose Unicode code points require surrogate pairs.
MuiIcon draws the original outlines with CoreText; it does not register a
global font, shape icon names as text, or download anything at runtime.

Use `MuiIcon(name: "lan", size: .sm)` and a canonical name from `glyphs.json`.
Adding a caller for an existing name needs no new asset. To update the library,
change `REVISION` in `tools/update-material-symbols.py`, then run it with Python 3
and `fonttools==4.62.1`. Commit the fonts, glyph map, and license together, update
this attribution revision, and run the MapleUI tests. The timestamp is preserved
from upstream so an unchanged revision regenerates identically.
