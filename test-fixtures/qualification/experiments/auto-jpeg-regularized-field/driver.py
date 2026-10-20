import sys
from pathlib import Path

sys.path.insert(
    0, "/Users/riabuz/.codex/worktrees/color-suite-progress/_Maple/src/scripts"
)
import auto_profile_match as gate

r = Path(__file__).resolve().parent
manifest = r.parent / "branch37-full-suite/source/test-fixtures/manifest.json"
priority = ["test_0005", "test_0015", "test_0017", "test_0002", "test_0014"]
selected = [row for row in gate.fixtures(None, manifest, "") if row[0] in priority]
selected.sort(key=lambda row: priority.index(row[0]))
assert len(selected) == 5
out = r / "pilot"
out.mkdir(exist_ok=False)
raise SystemExit(gate.qualify(r / "maple-cli", selected, out, 0.05))
