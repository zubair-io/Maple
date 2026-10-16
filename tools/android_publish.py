"""Publish a verified signed bundle to Maple's Google Play internal test track."""

import argparse
import hashlib
import json
import os
import urllib.error
import urllib.request
from pathlib import Path

PACKAGE = "app.justmaple.aperture"
ORIGIN = "https://androidpublisher.googleapis.com"


class Publisher:
    def __init__(self, token, origin=ORIGIN):
        self.token = token
        self.origin = origin

    def request(self, method, path, payload=None, bundle=None):
        headers = {"Authorization": f"Bearer {self.token}"}
        if bundle is not None:
            headers |= {
                "Content-Type": "application/octet-stream",
                "Content-Length": str(bundle.stat().st_size),
            }
            with bundle.open("rb") as stream:
                return self.send(method, path, headers, stream)
        body = json.dumps(payload).encode() if payload is not None else None
        headers["Content-Type"] = "application/json"
        return self.send(method, path, headers, body)

    def send(self, method, path, headers, body):
        request = urllib.request.Request(
            self.origin + path, data=body, headers=headers, method=method
        )
        try:
            with urllib.request.urlopen(request, timeout=300) as response:
                content = response.read()
                return json.loads(content) if content else {}
        except urllib.error.HTTPError as error:
            with error:
                message = (
                    error.read()
                    .decode(errors="replace")
                    .replace(self.token, "[redacted]")
                )
            raise RuntimeError(
                f"Play {method} failed ({error.code}): {message}"
            ) from None

    def publish(self, bundle, code, name):
        with bundle.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        base = f"/androidpublisher/v3/applications/{PACKAGE}/edits"
        edit = self.request("POST", base, {})["id"]
        path = f"{base}/{edit}"
        committed = False
        try:
            track = self.request("GET", f"{path}/tracks/internal")
            codes = {
                int(value)
                for release in track.get("releases", [])
                for value in release.get("versionCodes", [])
            }
            if codes and max(codes) > code:
                print(
                    f"Internal testing already has a newer build than {code}; keeping it."
                )
                return
            existing = self.request("GET", f"{path}/bundles").get("bundles", [])
            matching = next(
                (item for item in existing if int(item["versionCode"]) == code), None
            )
            uploaded = matching or self.request(
                "POST", f"/upload{path}/bundles?uploadType=media", bundle=bundle
            )
            if int(uploaded["versionCode"]) != code or uploaded["sha256"] != digest:
                raise ValueError(
                    "Play bundle version/hash differs from the signed artifact"
                )
            if code in codes and any(
                release.get("status") == "completed"
                and str(code) in release.get("versionCodes", [])
                for release in track.get("releases", [])
            ):
                print(f"Build {code} is already published with the same SHA-256.")
                return
            self.request(
                "PUT",
                f"{path}/tracks/internal",
                {
                    "track": "internal",
                    "releases": [
                        {
                            "name": name,
                            "versionCodes": [str(code)],
                            "status": "completed",
                        }
                    ],
                },
            )
            self.request(
                "POST", f"{path}:commit?changesInReviewBehavior=ERROR_IF_IN_REVIEW"
            )
            committed = True
            print(f"Published {name} ({code}) to internal testing; SHA-256 {digest}.")
        finally:
            if not committed:
                try:
                    self.request("DELETE", path)
                except RuntimeError as error:
                    if "(404)" not in str(error):
                        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle", type=Path)
    parser.add_argument("--version-code", type=int, required=True)
    parser.add_argument("--name", required=True)
    args = parser.parse_args()
    token = os.environ.get("GOOGLE_PLAY_ACCESS_TOKEN")
    if not token:
        parser.error("GOOGLE_PLAY_ACCESS_TOKEN is required")
    if not 1 <= args.version_code <= 2100000000:
        parser.error("version-code must be within Google's positive 32-bit range")
    Publisher(token).publish(args.bundle, args.version_code, args.name)
