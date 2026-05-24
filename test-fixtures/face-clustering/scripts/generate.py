#!/usr/bin/env python3
"""
Generate the face-clustering fixture set.

Two modes:

1. **LFW mode** (preferred — requires LFW + MobileFaceNet ONNX on disk).
   Walks aligned LFW crops, embeds them with the same MobileFaceNet the
   production indexer uses, and writes one JSONL line per face. Identities
   are the LFW person folder names. Selection is deterministic: identities
   sorted alphabetically, take the first `--identities` (default 20) that
   have at least `--per-identity` (default 10) images, take the first
   `--per-identity` images per identity.

2. **Synthetic mode** (CI-friendly fallback when LFW or the ONNX model is
   unreachable). Procedural Gaussian mixtures around 20 cluster centers in
   R^512, tuned to MobileFaceNet-like cosine distributions: intra-identity
   ~0.7, inter-identity ~0.2 (mean cosine similarity after L2 normalisation).
   The README documents that real-LFW budgets will differ; budgets.json
   notes which mode the committed fixtures were generated in.

Usage
-----

    # Synthetic (default; CI-safe, no downloads).
    python3 generate.py --mode synthetic --out ../embeddings.jsonl

    # LFW mode (manual; requires lfw-funneled at $LFW_ROOT and ONNX model
    # at $MAPLE_FACE_MODEL_DIR/mobilefacenet.onnx).
    LFW_ROOT=$HOME/data/lfw-funneled \\
    MAPLE_FACE_MODEL_DIR=$HOME/.maple/models \\
        python3 generate.py --mode lfw --out ../embeddings.jsonl

JSONL schema (one object per line):
    {
      "embedding": [..512 floats..],
      "identity": "person_A",
      "asset_id": "fixture_001",
      "face_index": 0
    }
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
from pathlib import Path
from typing import Iterator

EMBEDDING_DIM = 512


def l2_normalise(v: list[float]) -> list[float]:
    s = sum(x * x for x in v) ** 0.5
    if s == 0:
        return v
    return [x / s for x in v]


def cosine(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b))


# ---------------------------------------------------------------------------
# Synthetic mode
# ---------------------------------------------------------------------------


def gen_synthetic(
    *,
    identities: int,
    per_identity: int,
    seed: int,
    intra_target: float,
    inter_target: float,
    hard_fraction: float = 0.15,
) -> Iterator[dict]:
    """Procedural Gaussian-mixture embeddings.

    Each identity is a random unit vector `mu_k` in R^{512}. A face for
    identity k is drawn as:

        face = sigma * mu_k + sqrt(1 - sigma^2) * noise

    where `noise` is a fresh random unit vector orthogonalised against
    `mu_k`. After L2 normalising, the expected intra-identity cosine is
    `sigma^2` (same `mu_k` contribution), and the expected inter-identity
    cosine is `sigma^2 * <mu_i, mu_j>` ≈ 0 (random unit vectors in high-D
    have near-zero inner product).

    The MobileFaceNet target on aligned LFW is roughly:
        intra-identity cosine ~ 0.7   → sigma ~ sqrt(0.7) ≈ 0.836
        inter-identity cosine ~ 0.2   → not strictly reachable with the
          pure-orthogonal noise model (it gives ≈ 0). To approximate the
          common-background structure in real face embeddings we add a
          small shared global bias `mu_global` so all faces share a slight
          common direction (this lifts inter-identity cosines up to a
          chosen `inter_target`).

    The result: synthetic data that's easier than real LFW (clusters are
    cleaner, no occlusion / pose variation) but in the same numerical
    regime — useful as a sanity-check parity gate.
    """
    # Validate the cosine-target geometry up front so failures are
    # immediate and informative rather than surfacing as a Python
    # `ValueError: math domain error` deep inside the Gram-Schmidt loop.
    if not intra_target > inter_target:
        raise SystemExit(
            f"generate.py: --intra-target ({intra_target}) must be strictly greater than "
            f"--inter-target ({inter_target}); otherwise sqrt(intra - inter) goes complex."
        )
    if inter_target < 0:
        raise SystemExit(
            f"generate.py: --inter-target ({inter_target}) must be >= 0; otherwise "
            f"sqrt(inter_target) is undefined for the bias-weight derivation."
        )
    if not (0 < hard_fraction <= 1):
        raise SystemExit(
            f"generate.py: --hard-fraction ({hard_fraction}) must be in (0, 1]; "
            f"the modulo logic that distributes hard samples needs a positive denominator "
            f"and a fraction > 1 is meaningless."
        )

    rng = random.Random(seed)

    def rand_unit() -> list[float]:
        # Box-Muller for std-normal samples, then L2 normalise. Stable
        # across Python versions because we drive it off Random.gauss.
        v = [rng.gauss(0, 1) for _ in range(EMBEDDING_DIM)]
        return l2_normalise(v)

    mu_global = rand_unit()
    mus = [rand_unit() for _ in range(identities)]

    # Derive direction- and bias-weights from the cosine targets.
    # Choose `g` (bias weight) so inter-identity cosine ≈ inter_target.
    # The expected inter-identity cosine after L2 renormalisation is
    # approximately `g^2`; solving g = sqrt(inter_target).
    g = inter_target**0.5
    # Identity-specific weight: enough so the per-identity direction
    # dominates and intra-cosine ≈ intra_target.
    a = (intra_target - inter_target) ** 0.5

    # Inject `hard_fraction` of faces with double-noise weight — these
    # land further from their identity centroid (cosine ≈ 0.4–0.5) so they
    # exercise the algorithm's threshold-boundary behaviour. Without
    # these, every face is well inside the cosine ball and the algorithm
    # scores a trivial 1.0 across the board, which makes the harness
    # blind to regressions that only show up near the threshold.
    asset_counter = 0
    for k, mu_k in enumerate(mus):
        identity = f"synthetic_{k:02d}"
        # Orthogonalise mu_k against mu_global so the weights compose
        # cleanly. This keeps the math closer to its on-paper form.
        proj = cosine(mu_k, mu_global)
        mu_k_perp = [mu_k[i] - proj * mu_global[i] for i in range(EMBEDDING_DIM)]
        mu_k_perp = l2_normalise(mu_k_perp)

        for face_index in range(per_identity):
            # Hard fraction: drop the identity-direction weight `a` so
            # this face sits near the cosine threshold instead of well
            # inside its cluster. Hard samples are deterministic per
            # (identity, face_index) so re-runs are reproducible.
            is_hard = (face_index * identities + k) % max(
                1, int(round(1 / hard_fraction))
            ) == 0 and hard_fraction > 0
            local_a = a * 0.5 if is_hard else a
            # Noise component, orthogonal to mu_k_perp and mu_global.
            noise = [rng.gauss(0, 1) for _ in range(EMBEDDING_DIM)]
            # Gram-Schmidt: subtract projections on mu_global and mu_k_perp.
            p1 = cosine(noise, mu_global)
            for i in range(EMBEDDING_DIM):
                noise[i] -= p1 * mu_global[i]
            p2 = cosine(noise, mu_k_perp)
            for i in range(EMBEDDING_DIM):
                noise[i] -= p2 * mu_k_perp[i]
            noise = l2_normalise(noise)
            noise_weight = max(0.0, 1.0 - local_a * local_a - g * g) ** 0.5

            face = [
                local_a * mu_k_perp[i] + g * mu_global[i] + noise_weight * noise[i]
                for i in range(EMBEDDING_DIM)
            ]
            face = l2_normalise(face)

            asset_counter += 1
            yield {
                "embedding": face,
                "identity": identity,
                "asset_id": f"fixture_{asset_counter:04d}",
                "face_index": face_index,
            }

    # Print expected cosine stats for the README/PR description.
    print(
        f"# synthetic params: sigma_dir={a:.3f} sigma_global={g:.3f} "
        f"target_intra={intra_target} target_inter={inter_target}",
        file=sys.stderr,
    )


# ---------------------------------------------------------------------------
# LFW mode
# ---------------------------------------------------------------------------


def gen_lfw(
    *,
    lfw_root: Path,
    model_path: Path,
    identities: int,
    per_identity: int,
) -> Iterator[dict]:
    """Real LFW + MobileFaceNet. Imports are local so the synthetic path
    works on a stock Python without numpy/onnxruntime/Pillow."""
    try:
        import numpy as np
        from PIL import Image
        import onnxruntime as ort
    except ImportError as e:
        raise SystemExit(
            f"generate.py: LFW mode needs numpy + Pillow + onnxruntime — "
            f"install them or use --mode synthetic. ({e})"
        )

    if not lfw_root.exists():
        raise SystemExit(f"generate.py: LFW_ROOT does not exist: {lfw_root}")
    if not model_path.exists():
        raise SystemExit(f"generate.py: ONNX model not found: {model_path}")

    # Walk the funneled-LFW directory tree. Each subdirectory is a person.
    person_dirs = sorted(p for p in lfw_root.iterdir() if p.is_dir())
    chosen: list[tuple[str, list[Path]]] = []
    for person in person_dirs:
        imgs = sorted(person.glob("*.jpg"))
        if len(imgs) >= per_identity:
            chosen.append((person.name, imgs[:per_identity]))
        if len(chosen) >= identities:
            break

    if len(chosen) < identities:
        raise SystemExit(
            f"generate.py: only {len(chosen)} identities with ≥ {per_identity} images "
            f"in {lfw_root} — lower --per-identity or use --mode synthetic"
        )

    session = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
    input_name = session.get_inputs()[0].name

    asset_counter = 0
    for identity, imgs in chosen:
        for face_index, img_path in enumerate(imgs):
            asset_counter += 1
            # Funneled LFW images are already aligned at 250x250. Centre-
            # crop to 112x112 (MobileFaceNet input).
            img = Image.open(img_path).convert("RGB")
            w, h = img.size
            cx, cy = w // 2, h // 2
            box = (cx - 56, cy - 56, cx + 56, cy + 56)
            img = img.crop(box).resize((112, 112), Image.LANCZOS)
            arr = np.asarray(img, dtype=np.float32)
            arr = (arr - 127.5) / 128.0  # MobileFaceNet [-1, 1] normalisation
            arr = arr.transpose(2, 0, 1)[None]  # NCHW
            (out,) = session.run(None, {input_name: arr})
            emb = out.reshape(-1).astype(np.float32)
            # L2 normalise so downstream cosine == dot product.
            norm = float(np.linalg.norm(emb))
            if norm > 0:
                emb = emb / norm
            yield {
                "embedding": emb.tolist(),
                "identity": identity,
                "asset_id": f"fixture_{asset_counter:04d}",
                "face_index": face_index,
            }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--mode", choices=["synthetic", "lfw"], default="synthetic")
    parser.add_argument(
        "--out", default=str(Path(__file__).parent.parent / "embeddings.jsonl")
    )
    parser.add_argument("--identities", type=int, default=20)
    parser.add_argument("--per-identity", type=int, default=10)
    parser.add_argument("--seed", type=int, default=20260523)
    parser.add_argument("--intra-target", type=float, default=0.7)
    parser.add_argument("--inter-target", type=float, default=0.2)
    parser.add_argument(
        "--hard-fraction",
        type=float,
        default=0.15,
        help="Fraction of faces drawn near the cosine threshold (default 0.15, matches the seeded fixture) — these stress-test the algorithm and prevent trivial 1.0 scores.",
    )
    parser.add_argument("--lfw-root", default=os.environ.get("LFW_ROOT"))
    parser.add_argument(
        "--model-path",
        default=os.environ.get(
            "MAPLE_FACE_MOBILEFACENET",
            str(
                Path(
                    os.environ.get(
                        "MAPLE_FACE_MODEL_DIR", os.path.expanduser("~/.maple/models")
                    )
                )
                / "mobilefacenet.onnx"
            ),
        ),
    )
    args = parser.parse_args()

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    if args.mode == "synthetic":
        gen = gen_synthetic(
            identities=args.identities,
            per_identity=args.per_identity,
            seed=args.seed,
            intra_target=args.intra_target,
            inter_target=args.inter_target,
            hard_fraction=args.hard_fraction,
        )
    else:
        gen = gen_lfw(
            lfw_root=Path(args.lfw_root or ""),
            model_path=Path(args.model_path),
            identities=args.identities,
            per_identity=args.per_identity,
        )

    n = 0
    with out_path.open("w") as f:
        for row in gen:
            f.write(json.dumps(row, separators=(",", ":")))
            f.write("\n")
            n += 1
    print(
        f"generate.py: wrote {n} embeddings → {out_path} (mode={args.mode})",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
