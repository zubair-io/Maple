"""Effective Adobe settings shared by native reference-pair validation."""

import xml.etree.ElementTree as ET
from decimal import Decimal, InvalidOperation

from PIL import Image

CRS = "{http://ns.adobe.com/camera-raw-settings/1.0/}"
RDF = "{http://www.w3.org/1999/02/22-rdf-syntax-ns#}"


class _XmpTreeBuilder(ET.TreeBuilder):
    def doctype(self, name, pubid, system):
        raise ValueError("Camera Raw XMP must not declare a DTD")


def _scalar(value, key=""):
    value = (value or "").strip()
    boolean = {"true": "1", "false": "0", "on": "1", "off": "0"}
    spelling = boolean.get(value.casefold(), value)
    try:
        numbers = tuple(Decimal(part.strip()) for part in spelling.split(","))
    except InvalidOperation:
        return (
            value.casefold()
            if key
            in {
                CRS + name
                for name in ("WhiteBalance", "CameraProfile", "ToneCurveName2012")
            }
            else value
        )
    if not all(number.is_finite() for number in numbers):
        raise ValueError(f"non-finite Camera Raw value for {key}: {value}")
    return numbers[0] if len(numbers) == 1 else numbers


def _subtree(element):
    if not len(element) and not element.attrib:
        return _scalar(element.text, element.tag)
    return (
        element.tag,
        tuple(
            sorted((key, _scalar(value, key)) for key, value in element.attrib.items())
        ),
        _scalar(element.text),
        tuple((child.tag, _subtree(child)) for child in element),
    )


def camera_raw_settings(packet: bytes | str) -> dict:
    """Read every top-level CRS property, preserving complete nested payloads.

    Nested properties stay within their parent correction instead of being
    flattened and overwriting properties in a different mask. RDF sequence
    order remains significant. Conflicting duplicate properties fail closed.
    """
    settings = {}

    def add(key, value):
        if key in settings and settings[key] != value:
            raise ValueError(f"conflicting Camera Raw property {key}")
        settings[key] = value

    def visit(element):
        for key, value in element.attrib.items():
            if key.startswith(CRS):
                add(key, _scalar(value, key))
        for child in element:
            if child.tag.startswith(CRS):
                add(child.tag, _subtree(child))
            else:
                visit(child)

    visit(ET.fromstring(packet, parser=ET.XMLParser(target=_XmpTreeBuilder())))
    if not settings:
        raise ValueError("reference has no Camera Raw settings")
    return settings


def reference_crs(image: Image.Image) -> dict:
    """Canonical Camera Raw settings, including nested curves and local edits.

    Ignore container timestamps, but retain every CRS field (including process
    version). Refuse metadata-free pairs rather than infer matching settings
    from filenames. Decimal spelling and XML attribute order are immaterial.
    """
    packet = image.info.get("XML:com.adobe.xmp") or image.info.get("xmp")
    if not packet:
        raise ValueError(f"reference has no Camera Raw XMP: {image.filename}")
    return camera_raw_settings(packet)


def _sequence(property_name, values):
    element = ET.Element(CRS + property_name)
    sequence = ET.SubElement(element, RDF + "Seq")
    for value in values:
        ET.SubElement(sequence, RDF + "li").text = value
    return _subtree(element)


# Exact inactive values emitted by ACR 18.2.2/18.7 for the physical reference
# controls. An unrecognized field or any nonneutral value is never discarded.
_EMPTY_POINT_COLORS = _sequence("PointColors", [", ".join(["-1"] * 19)])
_EMPTY_COLOR_VARIANCE = _sequence("ColorVariance", ["-50"])
_DORMANT_PARENT = {
    "SharpenRadius": "Sharpness",
    "SharpenDetail": "Sharpness",
    "SharpenEdgeMasking": "Sharpness",
    "ColorNoiseReductionDetail": "ColorNoiseReduction",
    "ColorNoiseReductionSmoothness": "ColorNoiseReduction",
    "LuminanceNoiseReductionDetail": "LuminanceSmoothing",
    "LuminanceNoiseReductionContrast": "LuminanceSmoothing",
    "DefringePurpleHueLo": "DefringePurpleAmount",
    "DefringePurpleHueHi": "DefringePurpleAmount",
    "DefringeGreenHueLo": "DefringeGreenAmount",
    "DefringeGreenHueHi": "DefringeGreenAmount",
}


def verify_authoring_settings(expected: dict, actual: dict) -> None:
    """Compare the complete authored CRS state against one Adobe capture.

    Only capture-added bookkeeping, resolved named WB axes, and explicitly
    recognized inactive controls may be absent from the authoring sidecar.
    Authored values, unknown fields, curves and local adjustments must match.
    Full/down comparison additionally checks all capture-added properties.
    """
    for key in sorted(expected.keys() | actual.keys()):
        if key in expected and key in actual and expected[key] == actual[key]:
            continue
        name = key.removeprefix(CRS)
        parent = _DORMANT_PARENT.get(name)
        if (
            (key not in expected or key not in actual)
            and parent
            and expected.get(CRS + parent) == actual.get(CRS + parent) == 0
        ):
            continue
        if key not in expected:
            # These describe the exporting application/profile or rendered
            # container. If authored explicitly, they are still compared.
            if name in {
                "Version",
                "CameraProfileDigest",
                "AlreadyApplied",
                "HasSettings",
            }:
                continue
            wb = expected.get(CRS + "WhiteBalance")
            if wb == actual.get(CRS + "WhiteBalance"):
                # The named mode is the authored instruction. Adobe reports
                # the resolved axes (and Auto algorithm version) on export.
                named_wb = {
                    "as shot",
                    "auto",
                    "daylight",
                    "cloudy",
                    "shade",
                    "tungsten",
                    "fluorescent",
                    "flash",
                }
                if (
                    name in {"Temperature", "Tint"}
                    and wb in named_wb
                    and isinstance(actual[key], Decimal)
                    and (name == "Tint" or actual[key] > 0)
                ):
                    continue
                if (
                    name == "AutoWhiteVersion"
                    and wb == "auto"
                    and isinstance(actual[key], Decimal)
                    and actual[key] > 0
                ):
                    continue
            if (
                name in {"Glow", "ReshapeAmount", "OverrideLookVignette"}
                and actual[key] == 0
            ):
                continue
            if name == "PointColors" and actual[key] == _EMPTY_POINT_COLORS:
                continue
            if (
                name == "ColorVariance"
                and actual[key] == _EMPTY_COLOR_VARIANCE
                and actual.get(CRS + "PointColors") == _EMPTY_POINT_COLORS
                and CRS + "PointColors" not in expected
            ):
                continue
        raise ValueError(f"authoring/capture Camera Raw settings differ: {name}")
