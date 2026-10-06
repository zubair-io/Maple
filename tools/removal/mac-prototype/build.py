"""Build the local Mac research app using already provisioned model runtimes."""

import hashlib
import json
import plistlib
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[2]
CACHE = Path.home() / ".cache/maple-removal-research"
APP = Path.home() / "Applications/Maple Removal Lab.app"
CONFIG = {
    "cache": str(CACHE),
    "lamaPython": str(CACHE / "powerpaint-env/bin/python3.11"),
    "qwenPython": str(CACHE / "comparison-mlx-env/bin/python3"),
    "removalTools": str(APP / "Contents/Resources/tools"),
    "worker": str(APP / "Contents/Resources/worker.py"),
    "qwenManifest": str(APP / "Contents/Resources/qwen-manifest.json"),
    "probe": str(APP / "Contents/Resources/removal-scene-probe"),
    "sessions": str(Path.home() / "Documents/Maple Research/Mac Sessions"),
}
for key in ("lamaPython", "qwenPython"):
    if not Path(CONFIG[key]).exists():
        raise SystemExit(f"Missing existing local research dependency: {CONFIG[key]}")
subprocess.run(
    [
        "cargo",
        "build",
        "--release",
        "-p",
        "raw-core",
        "--example",
        "removal-scene-probe",
        "--target-dir",
        str(CACHE / "desktop-quality-target"),
    ],
    cwd=REPO / "src/raw-pipeline",
    check=True,
)
subprocess.run(["swift", "build", "-c", "release"], cwd=ROOT, check=True)
resources = APP / "Contents/Resources"
macos = APP / "Contents/MacOS"
resources.mkdir(parents=True, exist_ok=True)
macos.mkdir(parents=True, exist_ok=True)
for name in ("worker.py", "model_runner.py", "geometry.py"):
    shutil.copy2(ROOT / name, resources / name)
(resources / "tools").mkdir(exist_ok=True)
for name in ("guided_native_patches.py", "export_lama_native.py", "lama_fft_onnx.py"):
    shutil.copy2(REPO / "tools/removal" / name, resources / "tools" / name)
shutil.copy2(
    REPO
    / "tools/removal/research/2026-10-05/three-model-quality-20261005/qwen-manifest.json",
    resources / "qwen-manifest.json",
)
shutil.copy2(ROOT / ".build/release/MapleRemovalLab", macos / "MapleRemovalLab")
shutil.copy2(
    CACHE / "desktop-quality-target/release/examples/removal-scene-probe",
    resources / "removal-scene-probe",
)
(resources / "runtime.json").write_text(json.dumps(CONFIG, indent=2))
with (APP / "Contents/Info.plist").open("wb") as stream:
    plistlib.dump(
        {
            "CFBundleExecutable": "MapleRemovalLab",
            "CFBundleIdentifier": "app.justmaple.removal-research",
            "CFBundleName": "Maple Removal Lab",
            "CFBundlePackageType": "APPL",
            "CFBundleShortVersionString": "0.1",
            "CFBundleVersion": "1",
            "LSMinimumSystemVersion": "14.0",
            "NSHighResolutionCapable": True,
        },
        stream,
    )
subprocess.run(["codesign", "--force", "--deep", "--sign", "-", str(APP)], check=True)
files = [
    macos / "MapleRemovalLab",
    resources / "removal-scene-probe",
    resources / "worker.py",
    resources / "model_runner.py",
    resources / "geometry.py",
    *sorted((resources / "tools").glob("*.py")),
]
provenance = {
    "sourceCommit": subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=REPO, text=True
    ).strip(),
    "sourceDirty": bool(
        subprocess.check_output(
            ["git", "status", "--porcelain"], cwd=REPO, text=True
        ).strip()
    ),
    "files": {
        str(path.relative_to(APP)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in files
    },
    "releaseQualified": False,
}
(CACHE / "mac-prototype-build.json").write_text(json.dumps(provenance, indent=2))
print(APP)
