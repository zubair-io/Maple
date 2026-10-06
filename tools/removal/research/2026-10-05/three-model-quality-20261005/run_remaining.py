import subprocess
import time
from pathlib import Path

r = Path(__file__).parent
py = r.parent / "comparison-mlx-env/bin/python"
while not (r / "klein.log").read_text().rstrip().endswith("DONE"):
    time.sleep(3)
with (r / "klein-raw.log").open("w") as log:
    subprocess.run(
        [str(py), str(r / "run_mlx.py"), "klein", "1024", str(r / "raw")],
        stdout=log,
        stderr=subprocess.STDOUT,
        check=True,
    )
while not (r / "qwen-manifest.json").exists():
    time.sleep(3)
for mode in ["camera", "raw"]:
    with (r / f"qwen-{mode}.log").open("w") as log:
        args = [str(py), str(r / "run_mlx.py"), "qwen", "1024"] + (
            [str(r / "raw")] if mode == "raw" else []
        )
        subprocess.run(args, stdout=log, stderr=subprocess.STDOUT, check=True)
print("ALL MLX DONE", flush=True)
