import hashlib
import json
from pathlib import Path

from huggingface_hub import snapshot_download

r = Path(__file__).parent
pins = json.loads(
    Path(
        "/Users/riabuz/.codex/worktrees/2c7f/_Maple/tools/removal/klein-research-models.json"
    ).read_text()
)
q = json.loads((r / "qwen-hub.json").read_text())
for label, repo, rev in [
    ("klein", pins["repo"], pins["revision"]),
    ("qwen", q["id"], q["sha"]),
]:
    dest = r.parent / f"comparison-{label}-weights"
    print("Downloading", label, repo, rev, flush=True)
    snapshot_download(repo_id=repo, revision=rev, local_dir=dest, max_workers=4)
    rows = []
    for p in sorted(dest.rglob("*")):
        if p.is_file() and ".cache" not in p.relative_to(dest).parts:
            h = hashlib.sha256()
            with p.open("rb") as f:
                for b in iter(lambda: f.read(16 * 1024 * 1024), b""):
                    h.update(b)
            rows.append(
                {
                    "path": str(p.relative_to(dest)),
                    "bytes": p.stat().st_size,
                    "sha256": h.hexdigest(),
                }
            )
    expected = (
        {x["path"]: x["sha256"] for x in pins["files"]}
        if label == "klein"
        else {x["rfilename"]: x["lfs"]["sha256"] for x in q["siblings"] if "lfs" in x}
    )
    for row in rows:
        if row["path"] in expected:
            assert row["sha256"] == expected[row["path"]], row["path"]
    (r / f"{label}-manifest.json").write_text(
        json.dumps(
            {
                "repo": repo,
                "revision": rev,
                "path": str(dest),
                "files": rows,
                "releaseQualified": False,
            },
            indent=2,
        )
    )
    print("Verified", label, flush=True)
