#!/usr/bin/env python3
"""Add a full-resolution comparison viewer to an existing Auto/JPEG gallery."""

import argparse
import json
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlparse

from PIL import Image


class Gallery(HTMLParser):
    def __init__(self):
        super().__init__()
        self.cases = []
        self.case = None
        self.href = None
        self.notice = []
        self.in_notice = False
        self.in_heading = False
        self.heading = ""

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "section":
            self.case = {"name": attrs["id"], "images": {}}
            self.cases.append(self.case)
        if tag == "p" and attrs.get("class") == "notice":
            self.in_notice = True
        if tag == "h2":
            self.in_heading = True
        if tag == "a":
            self.href = attrs.get("href")
        if tag == "img" and self.case and self.href:
            preview = attrs["src"]
            key = next(
                (
                    key
                    for key in ("before", "after", "reference")
                    if preview.endswith(f"-{key}.png")
                ),
                None,
            )
            if key:
                self.case["images"][key] = {"original": self.href, "preview": preview}

    def handle_data(self, data):
        if self.in_notice:
            self.notice.append(data)
        if self.in_heading:
            self.heading += data

    def handle_endtag(self, tag):
        if tag == "section":
            self.case = None
        if tag == "p":
            self.in_notice = False
        if tag == "a":
            self.href = None
        if tag == "h2":
            if self.case:
                self.case["status"] = self.heading.rsplit(":", 1)[-1].strip().lower()
            self.heading = ""
            self.in_heading = False


def install(folder):
    folder = Path(folder).resolve()
    index, overview = folder / "index.html", folder / "overview.html"
    original = overview.read_text() if overview.exists() else index.read_text()
    gallery = Gallery()
    gallery.feed(original)
    if len(gallery.cases) != 16 or len({case["name"] for case in gallery.cases}) != 16:
        raise ValueError("expected all16 JPEG-bearing fixtures")
    for case in gallery.cases:
        if set(case["images"]) != {"before", "after", "reference"}:
            raise ValueError(f"incomplete triplet: {case['name']}")
        for image in case["images"].values():
            parsed = urlparse(image["original"])
            if parsed.scheme != "file" or parsed.netloc:
                raise ValueError("expected local physical-image links")
            with Image.open(unquote(parsed.path)) as source:
                image["size"] = list(source.size)
            if not (folder / image["preview"]).is_file():
                raise ValueError("missing comparison preview")
    data = {"notice": "".join(gallery.notice), "cases": gallery.cases}
    encoded = json.dumps(data).replace("<", "\\u003c")
    template = Path(__file__).with_suffix(".html").read_text()
    page = template.replace("__GALLERY_DATA__", encoded).replace(
        "__GALLERY_SCRIPT__", Path(__file__).with_suffix(".js").read_text()
    )
    if not overview.exists():
        overview.write_text(original)
    index.write_text(page)
    (folder / "viewer-data.json").write_text(json.dumps(data, indent=2) + "\n")
    print(index)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("gallery", type=Path)
    install(parser.parse_args().gallery)
