from pathlib import Path
import sys
sys.path.insert(0,"/Users/riabuz/.codex/worktrees/color-suite-progress/_Maple/src/scripts")
import auto_profile_match as gate
r=Path(__file__).resolve().parent
manifest=r.parent/"branch37-full-suite/source/test-fixtures/manifest.json"
priority=["test_0004","test_0006","test_0012","test_0002","test_0013","test_0003","test_0008","test_0010","test_0011"]
selected=gate.fixtures(None,manifest,"")
selected.sort(key=lambda row:(priority.index(row[0]) if row[0] in priority else len(priority),row[0]))
selected=[row for row in selected if row[0] in ["test_0015","test_0002","test_0004","test_0014"]]
selected.sort(key=lambda row: row[0] != "test_0015")
assert len(selected)==4
out=r/"pilot";out.mkdir(exist_ok=False)
raise SystemExit(gate.qualify(r/"maple-cli",selected,out,0.05))
