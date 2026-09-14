"""Stage explicit Adobe reference XMP without changing authored controls.

Omitted settings inherit ACR camera defaults, so pin the audited neutral state
for reference rendering (#3633). These Adobe-only sidecars are separate from
Maple's byte-identical canonical inputs; lens switches have different embedded
DNG opcode semantics in the two consumers.
"""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from pathlib import Path
from xml.sax.saxutils import escape

from matrix import CASES

CRS = "http://ns.adobe.com/camera-raw-settings/1.0/"
# These are reference controls, not operator configuration. Omitted values
# otherwise inherit camera defaults or embedded edits (#3633 / test_0015).
REFERENCE_DEFAULTS = {
    "ProcessVersion": "11.0",
    "Exposure2012": "0",
    "Contrast2012": "0",
    "Highlights2012": "0",
    "Shadows2012": "0",
    "Whites2012": "0",
    "Blacks2012": "0",
    "Texture": "0",
    "Clarity2012": "0",
    "Dehaze": "0",
    "Vibrance": "0",
    "Saturation": "0",
    "ParametricShadows": "0",
    "ParametricDarks": "0",
    "ParametricLights": "0",
    "ParametricHighlights": "0",
    "SplitToningShadowHue": "0",
    "SplitToningShadowSaturation": "0",
    "SplitToningHighlightHue": "0",
    "SplitToningHighlightSaturation": "0",
    "SplitToningBalance": "0",
    "ColorGradeMidtoneHue": "0",
    "ColorGradeMidtoneSat": "0",
    "ColorGradeShadowLum": "0",
    "ColorGradeMidtoneLum": "0",
    "ColorGradeHighlightLum": "0",
    "ColorGradeGlobalHue": "0",
    "ColorGradeGlobalSat": "0",
    "ColorGradeGlobalLum": "0",
    "LensProfileEnable": "0",
    "AutoLateralCA": "0",
    "LensManualDistortionAmount": "0",
    "VignetteAmount": "0",
    "DefringePurpleAmount": "0",
    "DefringeGreenAmount": "0",
    "PerspectiveVertical": "0",
    "PerspectiveHorizontal": "0",
    "PerspectiveRotate": "0",
    "PerspectiveAspect": "0",
    "PerspectiveX": "0",
    "PerspectiveY": "0",
    "GrainAmount": "0",
    "PostCropVignetteAmount": "0",
    "ShadowTint": "0",
    "RedHue": "0",
    "RedSaturation": "0",
    "GreenHue": "0",
    "GreenSaturation": "0",
    "BlueHue": "0",
    "BlueSaturation": "0",
    "HDREditMode": "0",
    "HueAdjustmentRed": "0",
    "HueAdjustmentOrange": "0",
    "HueAdjustmentYellow": "0",
    "HueAdjustmentGreen": "0",
    "HueAdjustmentAqua": "0",
    "HueAdjustmentBlue": "0",
    "HueAdjustmentPurple": "0",
    "HueAdjustmentMagenta": "0",
    "SaturationAdjustmentRed": "0",
    "SaturationAdjustmentOrange": "0",
    "SaturationAdjustmentYellow": "0",
    "SaturationAdjustmentGreen": "0",
    "SaturationAdjustmentAqua": "0",
    "SaturationAdjustmentBlue": "0",
    "SaturationAdjustmentPurple": "0",
    "SaturationAdjustmentMagenta": "0",
    "LuminanceAdjustmentRed": "0",
    "LuminanceAdjustmentOrange": "0",
    "LuminanceAdjustmentYellow": "0",
    "LuminanceAdjustmentGreen": "0",
    "LuminanceAdjustmentAqua": "0",
    "LuminanceAdjustmentBlue": "0",
    "LuminanceAdjustmentPurple": "0",
    "LuminanceAdjustmentMagenta": "0",
    "WhiteBalance": "As Shot",
    "ToneCurveName2012": "Linear",
    "PerspectiveUpright": "Off",
    "PerspectiveScale": "100",
    "ConvertToGrayscale": "false",
    "HasCrop": "false",
    "ToneCurvePV2012": ("0, 0", "255, 255"),
    "ToneCurvePV2012Red": ("0, 0", "255, 255"),
    "ToneCurvePV2012Green": ("0, 0", "255, 255"),
    "ToneCurvePV2012Blue": ("0, 0", "255, 255"),
    "Sharpness": "40",
    "SharpenRadius": "1",
    "SharpenDetail": "25",
    "SharpenEdgeMasking": "0",
    "LuminanceSmoothing": "0",
    "ColorNoiseReduction": "25",
    "ColorNoiseReductionDetail": "50",
    "ColorNoiseReductionSmoothness": "50",
    "ParametricShadowSplit": "25",
    "ParametricMidtoneSplit": "50",
    "ParametricHighlightSplit": "75",
    "ColorGradeBlending": "50",
}


REFERENCE_KEYS = {*REFERENCE_DEFAULTS, "CameraProfile"}


def reference_settings(data: bytes | str) -> dict[str, str | tuple[str, ...]]:
    """Read authored reference controls in RDF attribute or element form."""
    root = ET.fromstring(data)
    values = {}
    for element in root.iter():
        for key in REFERENCE_KEYS:
            qualified = "{" + CRS + "}" + key
            value = element.attrib.get(qualified)
            if element.tag == qualified:
                points = element.findall(
                    ".//{http://www.w3.org/1999/02/22-rdf-syntax-ns#}li"
                )
                value = (
                    tuple((point.text or "").strip() for point in points)
                    if points
                    else element.text
                )
            if value is not None:
                value = value.strip() if isinstance(value, str) else value
                if key in values and values[key] != value:
                    raise ValueError(f"conflicting {key} values")
                values[key] = value
    return values


def explicit_reference_defaults(
    data: bytes, camera_profile: str | None = None
) -> bytes:
    """Pin omitted defaults; preserve every authored control byte (#3633).

    Inject into the canonical RDF description without reserializing XML, so
    unrelated content, whitespace, unknown properties, and encoding stay intact.
    """
    authored = reference_settings(data)
    profile = authored.get("CameraProfile") or camera_profile
    if not isinstance(profile, str) or not profile:
        raise ValueError(
            "CameraProfile must be authored or selected from recorded reference settings"
        )
    defaults = dict(REFERENCE_DEFAULTS, CameraProfile=profile)
    missing = [key for key in defaults if key not in authored]
    if not missing:
        return data
    description = re.search(rb"<rdf:Description\b[^>]*>", data, re.DOTALL)
    if description is None or not re.search(rb'xmlns:crs\s*=\s*[\'"]', data):
        raise ValueError("canonical XMP must declare crs and rdf:Description")
    # An explicitly authored nonidentity point curve remains a custom curve,
    # even if its human-readable name was omitted from the canonical sidecar.
    if any(
        key.startswith("ToneCurvePV2012") and value != REFERENCE_DEFAULTS[key]
        for key, value in authored.items()
    ):
        defaults["ToneCurveName2012"] = "Custom"
    attributes = b"".join(
        b" crs:"
        + key.encode()
        + b'="'
        + escape(defaults[key], {'"': "&quot;"}).encode()
        + b'"'
        for key in missing
        if isinstance(defaults[key], str)
    )
    arrays = b"".join(
        b"<crs:"
        + key.encode()
        + b"><rdf:Seq>"
        + b"".join(
            b"<rdf:li>" + value.encode() + b"</rdf:li>" for value in defaults[key]
        )
        + b"</rdf:Seq></crs:"
        + key.encode()
        + b">"
        for key in missing
        if isinstance(defaults[key], tuple)
    )
    self_closing = description.group().endswith(b"/>")
    end = description.end() - (2 if self_closing else 1)
    suffix = b"</rdf:Description>" if self_closing and arrays else b""
    closing = b"/>" if self_closing and not arrays else b">"
    return (
        data[:end] + attributes + closing + arrays + suffix + data[description.end() :]
    )


def copy_case_xmp(
    source: Path, destination: Path, camera_profile: str | None = None
) -> None:
    # Read first: source == destination is safe and makes canonical self-runs
    # explicit too. No normalization or changes to authored controls.
    data = explicit_reference_defaults(source.read_bytes(), camera_profile)
    destination.write_bytes(data)


def copy_canonical_xmps(canonical_dir: Path, target_dir: Path) -> list[Path]:
    """Copy every canonical XMP into ``target_dir``, overwriting on conflict.

    Parameters
    ----------
    canonical_dir
        Directory containing ``<case>.xmp`` for every case in :data:`matrix.CASES`.
        In practice this is ``test-fixtures/references/test_0000/xmp/``.
    target_dir
        Destination. Created if missing.

    Returns
    -------
    list[Path]
        The destination paths that were written, in :data:`matrix.CASES` order.

    Raises
    ------
    FileNotFoundError
        If any canonical XMP is missing.
    """
    target_dir.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    missing: list[str] = []

    for case in CASES:
        src = canonical_dir / f"{case.name}.xmp"
        if not src.is_file():
            missing.append(case.name)
            continue
        dst = target_dir / f"{case.name}.xmp"
        copy_case_xmp(src, dst)
        written.append(dst)

    if missing:
        raise FileNotFoundError(
            f"Canonical XMPs missing from {canonical_dir}: {', '.join(missing)}"
        )

    return written


if __name__ == "__main__":
    import argparse
    import sys

    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--canonical",
        type=Path,
        required=True,
        help="Source directory containing the 43 canonical XMPs",
    )
    ap.add_argument(
        "--target",
        type=Path,
        required=True,
        help="Destination directory for the copied XMPs",
    )
    args = ap.parse_args()

    try:
        written = copy_canonical_xmps(args.canonical, args.target)
    except (FileNotFoundError, ValueError) as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)

    print(f"Wrote {len(written)} XMPs to {args.target}")
