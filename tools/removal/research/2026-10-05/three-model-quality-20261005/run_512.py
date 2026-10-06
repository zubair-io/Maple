import subprocess
from pathlib import Path

r = Path(__file__).parent
py = r.parent / "comparison-mlx-env/bin/python"
for kind in ["klein", "qwen"]:
    for mode in ["camera", "raw"]:
        with (r / f"{kind}-512-{mode}.log").open("w") as log:
            args = [str(py), str(r / "run_mlx.py"), kind, "512"] + (
                [str(r / "raw")] if mode == "raw" else []
            )
            subprocess.run(args, stdout=log, stderr=subprocess.STDOUT, check=True)
print("ALL 512 MLX DONE", flush=True)
