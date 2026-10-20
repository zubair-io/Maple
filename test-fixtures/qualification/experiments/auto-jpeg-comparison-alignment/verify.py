import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parent
source = root.parent / "auto-jpeg-quality-budget/full-suite"
old = json.loads((source / "summary.json").read_text())


def sha(p):
    with Path(p).open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


checks = []
for case in old["cases"]:
    assert sha(case["raw"]) == case["raw_sha256"], case["fixture"]
    row = {"fixture": case["fixture"], "raw_sha256": case["raw_sha256"]}
    folder = source / case["fixture"]
    if case["status"] != "no-preview":
        assert sha(folder / "auto.png") == case["candidate_sha256"]
        assert sha(folder / "embedded.png") == case["reference_sha256"]
        row.update(
            candidate_sha256=case["candidate_sha256"],
            reference_sha256=case["reference_sha256"],
        )
    checks.append(row)
    assert (
        sha(source.parent / "maple-cli")
        == "82f0adaa4dd595bdd6f2db1e76a018b62cf0826725779de605dc860fdfe8ecfe"
    )
repo = Path("/Users/riabuz/.codex/worktrees/color-suite-progress/_Maple")
for p in (root / "source").glob("*.py"):
    assert sha(p) == sha(repo / "src/scripts" / p.name)
(root / "verification.json").write_text(
    json.dumps(
        {
            "source_commit": "8c8c470982",
            "renderer_unchanged": True,
            "pipeline_output_version": 37,
            "fit_version": 7,
            "checks": checks,
            "source_hashes": {p.name: sha(p) for p in (root / "source").glob("*.py")},
            "binary_sha256": sha(source.parent / "maple-cli"),
        },
        indent=2,
    )
    + "\n"
)
print(
    "Verified all20RAWs,16candidate/reference pairs, frozen comparator sources and CLI"
)
