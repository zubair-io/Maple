#!/usr/bin/env python3
"""Validate the actual pinned CLI's effective config before review secrets (#4184)."""

import json
import sys
from pathlib import Path

config = json.loads(Path(sys.argv[1]).read_text())
agent = json.loads(Path(sys.argv[2]).read_text())
if config.get("default_agent") != "review" or agent.get("name") != "review":
    raise SystemExit("Muse must select the review agent; refusing review secrets")
if config.get("model") != "model_api/muse-spark-1.3" or agent.get("model") != {
    "providerID": "model_api",
    "modelID": "muse-spark-1.3",
}:
    raise SystemExit("Muse review model changed; refusing review secrets")
enabled = {name for name, allowed in agent["tools"].items() if allowed}
if enabled != {"read", "glob", "grep"}:
    raise SystemExit(
        f"Muse review tools must be read/glob/grep only, got {sorted(enabled)}"
    )
print(
    "Effective Muse reviewer verified: review agent, intended model, read/glob/grep only"
)
