#!/usr/bin/env python3
"""Record the actual #4140 stdio/GUI qualification checkpoints (never canned replies)."""

import argparse
import base64
import hashlib
import json
import subprocess
from pathlib import Path


def call(bridge, socket, name, arguments):
    messages = [
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {"protocolVersion": "2025-11-25"},
        },
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {"name": name, "arguments": arguments},
        },
    ]
    result = subprocess.run(
        [str(bridge), "--socket", str(socket)],
        input="".join(json.dumps(m) + "\n" for m in messages),
        text=True,
        capture_output=True,
        timeout=30,
        check=True,
    )
    replies = [json.loads(line) for line in result.stdout.splitlines()]
    payload = next(reply["result"] for reply in replies if reply.get("id") == 2)
    if payload.get("isError"):
        raise RuntimeError(json.dumps(payload))
    return payload


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bridge", type=Path, required=True)
    parser.add_argument("--copy", type=Path, required=True)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument(
        "--phase", choices=["before", "edit", "edited", "undo"], required=True
    )
    args = parser.parse_args()
    provenance = json.loads((args.copy / "provenance.json").read_text())
    fixture = Path(provenance["fixture"])
    socket = fixture.parent / "agent.sock"
    assert socket.exists(), "The actual isolated app socket must be listening"
    state = call(args.bridge, socket, "maple_get_active_photo", {})
    if args.phase == "edit":
        state = call(
            args.bridge,
            socket,
            "maple_set_adjustments",
            {
                "expected_revision": state["structuredContent"]["revision"],
                "adjustments": {"exposure": 1.25},
                "description": "Live GUI transport qualification",
            },
        )
        inspection = None
    else:
        inspection = call(
            args.bridge, socket, "maple_render_and_inspect", {"max_edge": 512}
        )
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
        "owned_socket": str(socket),
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
