from pathlib import Path
import sys
sys.path.insert(0,"/Users/riabuz/.codex/worktrees/color-suite-progress/_Maple/src/scripts")
import auto_profile_match as gate
r=Path(__file__).resolve().parent
manifest=r.parent/"branch37-full-suite/source/test-fixtures/manifest.json"
priority=["test_0009","test_0015","test_0005","test_0007","test_0004","test_0014","test_0017"]
selected=gate.fixtures(None,manifest,"")
selected.sort(key=lambda row:(priority.index(row[0]) if row[0] in priority else len(priority),row[0]))
assert len(selected)==20
out=r/"full-suite";out.mkdir(exist_ok=False)
raise SystemExit(gate.qualify(r/"maple-cli",selected,out,0.05))
