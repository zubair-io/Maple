"""Audit actual retained native person masks, without changing policy (#3941).

Requires numpy and blake3. Input is PhotographicRemovalGroupTests' retained
report and its exact RAW. Geometry/overlap is evidence, not ownership truth.
"""

import argparse
import hashlib
import json
import struct
from pathlib import Path

import blake3
import numpy as np


def content_digest(data):
    return "blake3:" + blake3.blake3(data).hexdigest()


def read_mask(directory, record, size):
    name = record["file"]
    if name != f"detected-{record['id']}.mimf":
        raise ValueError("Unexpected retained mask name")
    data = (directory / name).read_bytes()
    if content_digest(data) != record["digest"]:
        raise ValueError("Retained mask digest differs from the native report")
    if not data:
        return None
    if len(data) < 32 or data[:8] != b"MIMF\x01\x00\x00\x00":
        raise ValueError("Invalid MIMF version, flags or header")
    source_w, source_h, x, y, width, height = struct.unpack_from("<6I", data, 8)
    count = width * height
    if (
        [source_w, source_h] != size
        or min(width, height) == 0
        or x + width > source_w
        or y + height > source_h
        or len(data) != 32 + (count + 7) // 8
        or (count % 8 and data[-1] >> (count % 8))
    ):
        raise ValueError("Invalid source geometry, body size or padding")
    values = np.unpackbits(np.frombuffer(data[32:], dtype=np.uint8), bitorder="little")
    return (x, y, width, height), values[:count].reshape(height, width).astype(bool)


def common_pixels(first, second):
    if first is None or second is None:
        return 0
    (ax, ay, aw, ah), a = first
    (bx, by, bw, bh), b = second
    x, y = max(ax, bx), max(ay, by)
    end_x, end_y = min(ax + aw, bx + bw), min(ay + ah, by + bh)
    if end_x <= x or end_y <= y:
        return 0
    return int(
        np.count_nonzero(
            a[y - ay : end_y - ay, x - ax : end_x - ax]
            & b[y - by : end_y - by, x - bx : end_x - bx]
        )
    )


def active_bounds(mask):
    if mask is None:
        return None
    (x, y, _, _), values = mask
    ys, xs = np.nonzero(values)
    return (
        None
        if not len(xs)
        else [
            x + int(xs.min()),
            y + int(ys.min()),
            int(np.ptp(xs)) + 1,
            int(np.ptp(ys)) + 1,
        ]
    )


def audit(report_path, raw_path):
    report_bytes = report_path.read_bytes()
    report = json.loads(report_bytes)
    raw_bytes = raw_path.read_bytes()
    if content_digest(raw_bytes) != report["source"]["original"]:
        raise ValueError("RAW differs from the native report's original anchor")
    size = [report["source"]["width"], report["source"]["height"]]
    records = report["detectedMasks"]
    ids = [r["id"] for r in records]
    if len(ids) != len(set(ids)) or set(ids) != {p["id"] for p in report["detected"]}:
        raise ValueError("Retained mask IDs differ from the detector report")
    masks = {r["id"]: read_mask(report_path.parent, r, size) for r in records}
    counts = {
        key: 0 if mask is None else int(np.count_nonzero(mask[1]))
        for key, mask in masks.items()
    }
    people = [
        {
            **person,
            "pixels": counts[person["id"]],
            "storedFrame": None
            if masks[person["id"]] is None
            else masks[person["id"]][0],
            "activeFrame": active_bounds(masks[person["id"]]),
            "maskDigest": next(r["digest"] for r in records if r["id"] == person["id"]),
        }
        for person in report["detected"]
    ]
    pairs = []
    for index, first in enumerate(ids):
        for second in ids[index + 1 :]:
            common = common_pixels(masks[first], masks[second])
            if not common:
                continue
            pairs.append(
                {
                    "first": first,
                    "second": second,
                    "commonPixels": common,
                    "firstCoveredFraction": common / counts[first],
                    "secondCoveredFraction": common / counts[second],
                    "maskIoU": common / (counts[first] + counts[second] - common),
                }
            )
    return {
        "scope": "Exact retained pre-protection SAM mask overlaps and detector scores. No inferred distinct-person ownership, automatic deduplication, role or complete-removal quality claim.",
        "releaseQualified": False,
        "nativeReport": str(report_path),
        "nativeReportSHA256": hashlib.sha256(report_bytes).hexdigest(),
        "rawSHA256": hashlib.sha256(raw_bytes).hexdigest(),
        "sourceWH": size,
        "people": people,
        "overlappingPairs": pairs,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path)
    parser.add_argument("raw", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    result = audit(args.report, args.raw)
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(
        f"Audited {len(result['people'])} masks, {len(result['overlappingPairs'])} overlapping pairs"
    )


if __name__ == "__main__":
    main()
