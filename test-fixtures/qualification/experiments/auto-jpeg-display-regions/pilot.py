import sys
from pathlib import Path

sys.path.insert(
    0, "/Users/riabuz/.codex/worktrees/color-suite-progress/_Maple/src/scripts"
)
import auto_profile_match as gate

r = Path(__file__).resolve().parent
manifest = r.parent / "branch37-full-suite/source/test-fixtures/manifest.json"
priority = [
    "test_0004",
    "test_0006",
    "test_0012",
    "test_0002",
    "test_0013",
    "test_0003",
    "test_0008",
    "test_0010",
    "test_0011",
]
selected = [row for row in gate.fixtures(None, manifest, "") if row[0] in priority]
selected.sort(key=lambda row: priority.index(row[0]))
assert len(selected) == 9
out = r / "pilot"
out.mkdir(exist_ok=False)
raise SystemExit(gate.qualify(r / "maple-cli", selected, out, 0.05))
