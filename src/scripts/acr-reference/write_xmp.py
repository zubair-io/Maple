"""Stage explicit Adobe reference XMP without changing authored controls.

Omitted settings inherit ACR camera defaults, so pin the audited neutral state
for reference rendering (#3633). These Adobe-only sidecars are separate from
Maple's byte-identical canonical inputs; lens switches have different embedded
DNG opcode semantics in the two consumers.
"""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from decimal import Decimal, InvalidOperation
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
    "LuminanceNoiseReductionDetail": "50",
    "LuminanceNoiseReductionContrast": "0",
    "ColorNoiseReduction": "25",
    "ColorNoiseReductionDetail": "50",
    "ColorNoiseReductionSmoothness": "50",
    "ParametricShadowSplit": "25",
    "ParametricMidtoneSplit": "50",
    "ParametricHighlightSplit": "75",
    "ColorGradeBlending": "50",
}


REFERENCE_KEYS = {*REFERENCE_DEFAULTS, "CameraProfile"}
# These axes have no universal default: As Shot is camera/file dependent.
# Audit them when authored without inventing a pair for untouched cases (#4078).
OPTIONAL_REFERENCE_KEYS = {"Temperature", "Tint"}


def reference_settings(data: bytes | str) -> dict[str, str | tuple[str, ...]]:
    """Read authored reference controls in RDF attribute or element form."""
    root = ET.fromstring(data)
    values = {}
    for element in root.iter():
        for key in REFERENCE_KEYS | OPTIONAL_REFERENCE_KEYS:
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
    source: Path,
    destination: Path,
    camera_profile: str | None = None,
    *,
    as_shot: dict | None = None,
) -> None:
    # Read first: source == destination is safe and makes canonical self-runs
    # explicit too. No normalization or changes to authored controls.
    data = prepare_case_xmp(source.read_bytes(), camera_profile, as_shot=as_shot)
    destination.write_bytes(data)


def prepare_case_xmp(
    data: bytes, camera_profile: str | None = None, *, as_shot: dict | None = None
) -> bytes:
    return complete_custom_white_balance(
        explicit_reference_defaults(data, camera_profile), as_shot
    )


def as_shot_from_png(path: Path) -> dict | None:
    """Read effective As Shot settings from a fixture's recorded baseline."""
    from PIL import Image

    with Image.open(path) as image:
        metadata = image.info.get("XML:com.adobe.xmp") or image.info.get("xmp")
    if not metadata:
        return None
    settings = reference_settings(metadata)
    return (
        settings if settings.get("WhiteBalance", "").casefold() == "as shot" else None
    )


def complete_custom_white_balance(data: bytes, as_shot: dict | None) -> bytes:
    """Complete Adobe's required WB pair from this fixture's recorded baseline.

    ACR ignores a Custom tint-only sidecar. Supply only its missing axis from
    effective As Shot PNG metadata; never alter Maple's canonical input or
    invent a camera-independent temperature/tint default (#2333, #3678).
    """
    authored = reference_settings(data)
    missing = sorted(OPTIONAL_REFERENCE_KEYS - authored.keys())
    if authored.get("WhiteBalance", "").casefold() != "custom" or not missing:
        return data
    if not as_shot or as_shot.get("WhiteBalance", "").casefold() != "as shot":
        raise ValueError(
            "partial Custom WB requires recorded As Shot baseline settings"
        )
    for key in missing:
        try:
            value = Decimal(as_shot[key])
        except (KeyError, TypeError, InvalidOperation) as error:
            raise ValueError(
                f"recorded As Shot baseline is missing valid {key}"
            ) from error
        if not value.is_finite() or (key == "Temperature" and value <= 0):
            raise ValueError(f"recorded As Shot baseline has invalid {key}")
    description = re.search(rb"<rdf:Description\b[^>]*>", data, re.DOTALL)
    if description is None:
        raise ValueError("canonical XMP must declare rdf:Description")
    end = description.end() - (2 if description.group().endswith(b"/>") else 1)
    attributes = b"".join(
        f' crs:{key}="{Decimal(as_shot[key])}"'.encode() for key in missing
    )
    return data[:end] + attributes + data[end:]


def copy_canonical_xmps(
    canonical_dir: Path, target_dir: Path, *, as_shot: dict | None = None
) -> list[Path]:
    """Prepare every Adobe XMP before writing the batch into ``target_dir``.

    Parameters
    ----------
    canonical_dir
        Directory containing ``<case>.xmp`` for every case in :data:`matrix.CASES`.
        In practice this is ``test-fixtures/references/test_0000/xmp/``.
    target_dir
        Destination. Created if missing.
    as_shot
        Effective As Shot settings for the destination photo. Required when
        any canonical case has an incomplete Custom white-balance pair.

    Returns
    -------
    list[Path]
        The destination paths that were written, in :data:`matrix.CASES` order.

    Raises
    ------
    FileNotFoundError
        If any canonical XMP is missing.
    """
    missing = [
        case.name
        for case in CASES
        if not (canonical_dir / f"{case.name}.xmp").is_file()
    ]
    if missing:
        raise FileNotFoundError(
            f"Canonical XMPs missing from {canonical_dir}: {', '.join(missing)}"
        )

    prepared = [
        (
            target_dir / f"{case.name}.xmp",
            prepare_case_xmp(
                (canonical_dir / f"{case.name}.xmp").read_bytes(),
                (as_shot or {}).get("CameraProfile"),
                as_shot=as_shot,
            ),
        )
        for case in CASES
    ]
    target_dir.mkdir(parents=True, exist_ok=True)
    for path, data in prepared:
        path.write_bytes(data)
    return [path for path, _ in prepared]


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
    ap.add_argument(
        "--as-shot-baseline",
        type=Path,
        help="The destination photo's recorded As Shot baseline PNG (required for partial Custom WB)",
    )
    args = ap.parse_args()

    try:
        as_shot = (
            as_shot_from_png(args.as_shot_baseline) if args.as_shot_baseline else None
        )
        written = copy_canonical_xmps(args.canonical, args.target, as_shot=as_shot)
    except (FileNotFoundError, ValueError) as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)

    print(f"Wrote {len(written)} XMPs to {args.target}")
