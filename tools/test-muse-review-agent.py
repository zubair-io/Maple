#!/usr/bin/env python3
"""Check the actual CLI probe and rejected review capabilities before secrets."""

import copy
import json
import subprocess
import sys
import tempfile
from pathlib import Path

checker = Path(__file__).with_name("check-muse-review-agent.py")
config = json.loads(Path(sys.argv[1]).read_text())
agent = json.loads(Path(sys.argv[2]).read_text())

with tempfile.TemporaryDirectory(prefix="muse-agent-controls-") as directory:
    root = Path(directory)

    def check(configuration, reviewer):
        (root / "config.json").write_text(json.dumps(configuration))
        (root / "agent.json").write_text(json.dumps(reviewer))
        return subprocess.run(
            [
                sys.executable,
                str(checker),
                str(root / "config.json"),
                str(root / "agent.json"),
            ],
            capture_output=True,
            text=True,
            check=False,
        )

    result = check(config, agent)
    if result.returncode:
        raise SystemExit(result.stderr)
    rejected = []
    before = copy.deepcopy(config)
    before.pop("default_agent", None)
    rejected.append(("missing effective default", before, agent))
    for capability in ("bash", "write", "edit", "task"):
        unsafe = copy.deepcopy(agent)
        unsafe["tools"][capability] = True
        rejected.append((f"enabled {capability}", config, unsafe))
    changed = copy.deepcopy(config)
    changed["model"] = "other/model"
    rejected.append(("changed model", changed, agent))
    for description, configuration, reviewer in rejected:
        result = check(configuration, reviewer)
        if result.returncode == 0:
            raise SystemExit(f"Reviewer guard accepted {description}")
    print("Actual reviewer accepted; six unsafe/default/model controls rejected")
