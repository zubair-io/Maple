#!/usr/bin/env python3
"""Record the actual #4140 HTTP/GUI qualification checkpoints (never canned replies)."""

import argparse
import base64
import hashlib
import json
import re
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit


def call(url, token, name, arguments):
    message = {
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/call",
        "params": {"name": name, "arguments": arguments},
    }
    request = urllib.request.Request(
        url,
        data=json.dumps(message).encode(),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "MCP-Protocol-Version": "2025-11-25",
        },
    )

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            raise RuntimeError("The owned Maple endpoint must not redirect")

    with urllib.request.build_opener(NoRedirect).open(request, timeout=30) as response:
        data = response.read(2 * 1024 * 1024 + 1)
        assert len(data) <= 2 * 1024 * 1024, "Oversized qualification reply"
    reply = json.loads(data)
    if "error" in reply:
        raise RuntimeError(json.dumps(reply["error"]))
    payload = reply["result"]
    if payload.get("isError"):
        raise RuntimeError(json.dumps(payload))
    return payload


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--setup-prompt", type=Path, required=True)
    parser.add_argument("--copy", type=Path, required=True)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument(
        "--phase", choices=["before", "edit", "edited", "undo"], required=True
    )
    args = parser.parse_args()
    provenance = json.loads((args.copy / "provenance.json").read_text())
    fixture = Path(provenance["fixture"])
    # The copied prompt is a credential; never include it in evidence or stdout.
    prompt = args.setup_prompt.read_text()
    url_match = re.search(r"^Server URL: (.+)$", prompt, re.MULTILINE)
    token_match = re.search(
        r"^Authorization header: Bearer ([0-9a-f]{64})$", prompt, re.MULTILINE
    )
    assert url_match and token_match, "Copy the actual owned app's setup prompt"
    url = url_match.group(1).strip()
    endpoint = urlsplit(url)
    assert endpoint.scheme == "http" and endpoint.hostname == "127.0.0.1"
    assert (
        endpoint.path == "/mcp"
        and endpoint.port
        and not endpoint.query
        and not endpoint.fragment
    )
    assert not endpoint.username and not endpoint.password
    assert str(Path.home() / "Library/Containers" / provenance["bundle_id"]) in str(
        fixture
    )
    token = token_match.group(1)
    state = call(url, token, "maple_get_active_photo", {})
    listing = call(url, token, "maple_list_photos", {"offset": 0, "limit": 100})
    active = next(
        photo
        for photo in listing["structuredContent"]["photos"]
        if photo["id"] == state["structuredContent"]["photo_id"]
    )
    assert Path(active["path"]).resolve() == fixture.resolve(), (
        "Wrong app or active photo"
    )
    if args.phase == "edit":
        state = call(
            url,
            token,
            "maple_set_adjustments",
            {
                "expected_revision": state["structuredContent"]["revision"],
                "adjustments": {"exposure": 1.25},
                "description": "Live GUI transport qualification",
            },
        )
        inspection = None
    else:
        inspection = call(url, token, "maple_render_and_inspect", {"max_edge": 512})
        image = next(
            content
            for content in inspection["content"]
            if content.get("type") == "image"
        )
        (args.evidence / f"live-gui-{args.phase}-inspect.jpg").write_bytes(
            base64.b64decode(image["data"], validate=True)
        )
    source_hash = hashlib.sha256(fixture.read_bytes()).hexdigest()
    assert source_hash == provenance["source_fixture_sha256"], "Original bytes changed"
    sidecar = Path(provenance["sidecar"])
    xmp = sidecar.read_bytes()
    (args.evidence / f"live-gui-{args.phase}.xmp").write_bytes(xmp)
    record = {
        "phase": args.phase,
        "state": state,
        "inspection": inspection,
        "original_sha256": source_hash,
        "xmp_sha256": hashlib.sha256(xmp).hexdigest(),
        "owned_endpoint": url,
    }
    (args.evidence / f"live-gui-{args.phase}-transport.json").write_text(
        json.dumps(record, indent=2) + "\n"
    )
    fields = state["structuredContent"]
    exposure = (
        fields.get("adjustments", {})
        .get("exposure", {})
        .get("value", fields.get("applied", {}).get("exposure"))
    )
    print(
        json.dumps(
            {
                "phase": args.phase,
                "photo_id": fields["photo_id"],
                "revision": fields["revision"],
                "exposure": exposure,
                "can_undo": fields["can_undo"],
                "inspection": inspection and inspection["structuredContent"],
                "original_sha256": source_hash,
            }
        )
    )


if __name__ == "__main__":
    main()
