import sys
from pathlib import Path

sys.path.insert(
    0, "/Users/riabuz/.codex/worktrees/color-suite-progress/_Maple/src/scripts"
)
import auto_profile_match as gate

root = Path(__file__).resolve().parent
manifest = Path(
    "/Users/riabuz/.codex/color-suite-evidence/5000/branch37-full-suite/source/test-fixtures/manifest.json"
)
all_cases = dict(gate.fixtures(None, manifest, ""))
# Three other established passing controls, then the three worst failures
# and the independent Canon bake witness.0003runs separately already.
names = [
    "test_0002",
    "test_0003",
    "test_0004",
    "test_0009",
    "test_0017",
    "test_0015",
    "test_0012",
    "test_0010",
]
selected = [(name, all_cases[name]) for name in names]
out = root / "remaining"
out.mkdir(exist_ok=False)
raise SystemExit(gate.qualify(root / "maple-cli", selected, out, 0.05))
