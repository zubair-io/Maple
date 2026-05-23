"""Case matrix for the reference-renderer reference corpus.

Each case is one reference XMP sidecar (the ``crs:`` namespace, process version PV2012)
that isolates one dimension of the develop pipeline. The matrix total is 43 cases;
see ``test-fixtures/references/REFERENCES.md`` for the user-facing documentation.

Two tiers are rendered:

- ``down`` — long edge 4000 px, bicubic-sharper downsample. Tone/WB/presence cases.
- ``full`` — native resolution. Sharpen + NR cases (+ baseline, for dual-tier compare).

``baseline`` is emitted at both tiers; every other case lives in exactly one.

The XMP slider values are intentionally encoded here as prose (via ``Case.overrides``)
for documentation. The actual bytes written to disk come from the canonical
XMP set under ``test-fixtures/references/test_0000/xmp/`` (see ``run.py`` —
rationale: the canonical set has already driven 176 committed PNGs, so we
copy bytes rather than re-emit them to avoid parity drift).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

Tier = Literal["down", "full"]


@dataclass(frozen=True)
class Case:
    """One reference case.

    Attributes
    ----------
    name
        Slug matching the XMP filename stem, e.g. ``exposure_max``.
    tiers
        Which resolution tiers this case renders at. ``baseline`` is in both.
    overrides
        Prose description of the ``crs:`` slider overrides this case sets,
        relative to reference-renderer defaults. Purely documentation — not consumed at runtime.
    """

    name: str
    tiers: tuple[Tier, ...]
    overrides: str


# Reference-renderer PV2012 defaults referenced by every case (prose only; the canonical XMPs
# encode these explicitly so the sidecar is self-contained on ``app.open()``).
DEFAULTS = (
    'ProcessVersion="11.0" WhiteBalance="As Shot" '
    'Sharpness=40 SharpenRadius=1.0 SharpenDetail=25 SharpenEdgeMasking=0 '
    'LuminanceSmoothing=0 ColorNoiseReduction=25'
)

CASES: tuple[Case, ...] = (
    Case("baseline", ("down", "full"), "(no overrides — reference-renderer defaults)"),
    # White balance presets
    Case("wb_auto", ("down",), 'WhiteBalance="Auto"'),
    Case("wb_daylight", ("down",), 'WhiteBalance="Daylight"'),
    Case("wb_cloudy", ("down",), 'WhiteBalance="Cloudy"'),
    Case("wb_shade", ("down",), 'WhiteBalance="Shade"'),
    Case("wb_tungsten", ("down",), 'WhiteBalance="Tungsten"'),
    Case("wb_flash", ("down",), 'WhiteBalance="Flash"'),
    # Tone
    Case("exposure_min", ("down",), "Exposure2012=-5.00"),
    Case("exposure_max", ("down",), "Exposure2012=+5.00"),
    Case("contrast_min", ("down",), "Contrast2012=-100"),
    Case("contrast_max", ("down",), "Contrast2012=+100"),
    Case("highlights_min", ("down",), "Highlights2012=-100"),
    Case("highlights_max", ("down",), "Highlights2012=+100"),
    Case("shadows_min", ("down",), "Shadows2012=-100"),
    Case("shadows_max", ("down",), "Shadows2012=+100"),
    Case("whites_min", ("down",), "Whites2012=-100"),
    Case("whites_max", ("down",), "Whites2012=+100"),
    Case("blacks_min", ("down",), "Blacks2012=-100"),
    Case("blacks_max", ("down",), "Blacks2012=+100"),
    # Custom WB
    Case("temperature_min", ("down",), 'WhiteBalance="Custom" Temperature=2000 Tint=0'),
    Case("temperature_max", ("down",), 'WhiteBalance="Custom" Temperature=50000 Tint=0'),
    Case("tint_min", ("down",), 'WhiteBalance="Custom" Tint=-150'),
    Case("tint_max", ("down",), 'WhiteBalance="Custom" Tint=+150'),
    # Presence
    Case("clarity_min", ("down",), "Clarity2012=-100"),
    Case("clarity_max", ("down",), "Clarity2012=+100"),
    Case("texture_min", ("down",), "Texture=-100"),
    Case("texture_max", ("down",), "Texture=+100"),
    Case("dehaze_min", ("down",), "Dehaze=-100"),
    Case("dehaze_max", ("down",), "Dehaze=+100"),
    Case("vibrance_min", ("down",), "Vibrance=-100"),
    Case("vibrance_max", ("down",), "Vibrance=+100"),
    Case("saturation_min", ("down",), "Saturation=-100"),
    Case("saturation_max", ("down",), "Saturation=+100"),
    # Sharpen
    Case("sharpen_amount_min", ("full",), "Sharpness=0"),
    Case("sharpen_amount_max", ("full",), "Sharpness=150"),
    Case("sharpen_radius_min", ("full",), "SharpenRadius=0.5"),
    Case("sharpen_radius_max", ("full",), "SharpenRadius=3.0"),
    Case("sharpen_detail_min", ("full",), "SharpenDetail=0"),
    Case("sharpen_detail_max", ("full",), "SharpenDetail=100"),
    Case("sharpen_masking_max", ("full",), "SharpenEdgeMasking=100"),
    # Noise reduction
    Case("nr_luminance_max", ("full",), "LuminanceSmoothing=100"),
    Case("nr_color_min", ("full",), "ColorNoiseReduction=0"),
    Case("nr_color_max", ("full",), "ColorNoiseReduction=100"),
)


def case_names() -> list[str]:
    """Return the 43 case names in matrix order."""
    return [c.name for c in CASES]


def count_tier(tier: Tier) -> int:
    """Count how many cases render at ``tier``."""
    return sum(1 for c in CASES if tier in c.tiers)


if __name__ == "__main__":
    import sys

    if len(CASES) != 43:
        print(f"ERROR: expected 43 cases, got {len(CASES)}", file=sys.stderr)
        sys.exit(1)

    print(f"{len(CASES)} cases — down: {count_tier('down')}, full: {count_tier('full')}")
    for c in CASES:
        tiers = "+".join(c.tiers)
        print(f"  {c.name:<24} [{tiers:<9}]  {c.overrides}")
