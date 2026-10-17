"""Effective Adobe settings shared by native reference-pair validation."""

import xml.etree.ElementTree as ET
from decimal import Decimal, InvalidOperation

from PIL import Image


def reference_crs(image: Image.Image) -> dict:
    """Canonical Camera Raw settings, including nested curves and local edits.

    Ignore container timestamps, but retain every CRS field (including process
    version). Refuse metadata-free pairs rather than infer matching settings
    from filenames. Decimal spelling and XML attribute order are immaterial.
    """
    packet = image.info.get("XML:com.adobe.xmp") or image.info.get("xmp")
    if not packet:
        raise ValueError(f"reference has no Camera Raw XMP: {image.filename}")
    root = ET.fromstring(packet)
    namespace = "{http://ns.adobe.com/camera-raw-settings/1.0/}"

    def scalar(value):
        value = (value or "").strip()
        try:
            return Decimal(value)
        except InvalidOperation:
            return value

    def subtree(element):
        return (
            element.tag,
            tuple(
                sorted((key, scalar(value)) for key, value in element.attrib.items())
            ),
            scalar(element.text),
            tuple(subtree(child) for child in element),
        )

    settings = {}
    for element in root.iter():
        for key, value in element.attrib.items():
            if key.startswith(namespace):
                settings[key] = scalar(value)
        if element.tag.startswith(namespace):
            settings[element.tag] = (
                subtree(element) if len(element) else scalar(element.text)
            )
    if not settings:
        raise ValueError(f"reference has no Camera Raw settings: {image.filename}")
    return settings
