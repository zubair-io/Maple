import json
import sys
from pathlib import Path

sys.path.insert(
    0, "/Users/riabuz/.codex/worktrees/color-suite-progress/_Maple/src/scripts"
)
import auto_profile_match as gate

r = Path(__file__).resolve().parent
manifest = Path(
    "/Users/riabuz/.codex/color-suite-evidence/5000/branch37-full-suite/source/test-fixtures/manifest.json"
)
selected = [
    (name, raw)
    for name, raw in gate.fixtures(None, manifest, "")
    if name != "test_0017"
]
assert len(selected) == 19
identity = json.loads((r / "identity.json").read_text())
assert gate.sha(r / "maple-cli") == identity["binary_sha256"]
out = r / "final-rest"
out.mkdir(exist_ok=False)
raise SystemExit(gate.qualify(r / "maple-cli", selected, out, 0.05))
