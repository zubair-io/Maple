# Face-clustering parity fixtures

Quality-parity gate for the face-clustering subsystem. Mirrors the
color-pipeline harness pattern (`src/scripts/test_color_pipeline.sh` +
`test-fixtures/budgets.json`) so clustering-algorithm changes can be
measured objectively rather than by eyeballing the People panel.

## What's committed

- `embeddings.jsonl` — 200 face embeddings labelled with ground-truth
  identity (20 identities × 10 faces each). Each line is one JSON object:

  ```json
  {
    "embedding": [..512 floats..],
    "identity": "synthetic_00",
    "asset_id": "fixture_0001",
    "face_index": 0
  }
  ```

- `budgets.json` — per-metric floors. The harness FAILs if any metric
  falls below its floor. **One-way ratchet**: floors can only get
  tighter, in the same commit that delivers the improvement.

- `scripts/generate.py` — regenerator with two modes:
  - `--mode synthetic` (default, CI-safe): procedural Gaussian-mixture
    embeddings in R^512 with MobileFaceNet-like cosine distributions
    (intra ≈ 0.70, inter ≈ 0.20). Includes a `--hard-fraction` knob
    (default 0.15) that draws a fraction of faces near the cosine
    threshold so the algorithm actually exercises its decision boundary;
    without this, every metric scores a trivial 1.0 and the gate is
    blind to subtle regressions.
  - `--mode lfw` (operator-only): walks an aligned LFW dataset, runs the
    production MobileFaceNet ONNX over each crop, and writes the same
    JSONL. Used to re-seed budgets with real-data numbers on operator
    hardware where the model + LFW are available.

## Synthetic vs LFW

**The committed `embeddings.jsonl` is synthetic.** LFW + the MobileFaceNet
ONNX model are not reachable from the build environment, so the
committed fixture is the procedural fallback. Synthetic data is _easier_
than real LFW because:

- No occlusion, pose, lighting variation.
- Every identity has the same isotropic-noise structure.
- The "hard fraction" knob is uniform, not drawn from the long tail of
  real-world failure modes.

In practice this means **synthetic budgets are an upper bound on
real-LFW budgets** for the same algorithm. When the operator regenerates
the fixture in LFW mode, the budget numbers will move (likely down for
NMI/ARI/recall@1, possibly down for purity too).

To switch the committed fixture to LFW:

```bash
# 1. Download funneled LFW (operator-side; LFW is not auto-downloaded by
#    this script — the operator must have it on disk).
#    https://vis-www.cs.umass.edu/lfw/lfw-funneled.tgz
mkdir -p ~/data && cd ~/data && tar xzf lfw-funneled.tgz

# 2. Make sure the MobileFaceNet ONNX is present at the same path
#    the indexer uses.
ls ~/.maple/models/mobilefacenet.onnx

# 3. Regenerate.
LFW_ROOT=~/data/lfw-funneled \
  python3 test-fixtures/face-clustering/scripts/generate.py \
    --mode lfw --out test-fixtures/face-clustering/embeddings.jsonl

# 4. Re-seed budgets from the new measurement.
bun src/api/src/people/clustering-quality-harness.ts \
    --suggest-budgets > test-fixtures/face-clustering/budgets.json

# 5. Hand-edit budgets.json to flip `fixtures_mode` to "lfw" and clear
#    the synthetic-mode note.
```

## How the harness works

```
test-fixtures/face-clustering/embeddings.jsonl
                │
                ▼
   src/scripts/test_face_clustering.sh
                │  (skip-pass if fixtures or budgets missing)
                ▼
   bun src/api/src/people/clustering-quality-harness.ts
                │  loads embeddings → calls pure `clusterEmbeddings`
                │  → computes purity, NMI, V-measure, ARI, recall@1
                ▼
   compare against test-fixtures/face-clustering/budgets.json
                │
                ▼
   exit 0 if all floors met, 1 if any breach, 2 on input error
```

The harness does **not** touch MongoDB. It calls the pure-function core
`clusterEmbeddings` imported directly from
`src/api/src/people/cluster-embeddings.ts` — the canonical pure module
that has no Mongo / pino / Elysia dependencies. (`clustering-job.ts`
re-exports the same symbol for back-compat, but importing it pulls in
the DB-backed wrapper's transitive deps, which the harness deliberately
avoids.) The DB-backed `runOnlineClustering` in `clustering-job.ts`
calls into the same pure function internally to make assignment
decisions; it just adds load / persist around the same math.

## Metric meanings (one-line versions)

| Metric        | Definition                                                                      | Range  | Direction |
| ------------- | ------------------------------------------------------------------------------- | ------ | --------- |
| `purity`      | Fraction of faces whose cluster's majority class matches truth                  | [0, 1] | higher    |
| `nmi`         | Normalised mutual info (arithmetic-mean normaliser; sklearn default)            | [0, 1] | higher    |
| `v_measure`   | Harmonic mean of homogeneity & completeness (Rosenberg & Hirschberg 2007)       | [0, 1] | higher    |
| `ari`         | Adjusted Rand index (chance-corrected pair agreement; Hubert & Arabie 1985)     | [-1, 1]| higher    |
| `recall_at_1` | Fraction of faces whose majority same-cluster neighbour shares the true label   | [0, 1] | higher    |

Why all five (not just one)? Each metric has a blind spot:

- **Purity is fooled by over-fragmentation.** A clustering that puts
  every face in its own cluster trivially scores 1.0. NMI/V-measure/ARI
  penalise that.
- **NMI is fooled by under-fragmentation.** Two truly-different
  identities merged into one big cluster can still score high if other
  clusters are clean.
- **ARI is the strictest** (chance-corrected pair agreement) but reads
  poorly on its own.
- **Recall@1 is the user-visible metric** — "when I tap a face, do the
  rest of the cluster actually look like the same person?"

A regression visible in only one metric usually indicates a specific
failure mode (e.g. ARI down but purity up = under-clustering).

## Initial budget measurement (2026-05-23)

Committed budgets were seeded from this single run:

```
fixture: synthetic (intra=0.7 / inter=0.2 / hard_fraction=0.15 / seed=20260523)
algorithm: online clustering (threshold=0.5) — current production path
n=200 (20 identities × 10 faces) → 33 predicted clusters in ~10ms

measured:
  purity       1.0000
  nmi          0.9659
  v_measure    0.9659
  ari          0.9274
  recall_at_1  0.9350

floors (committed):
  purity_min       0.97
  nmi_min          0.9359
  v_measure_min    0.9359
  ari_min          0.8974
  recall_at_1_min  0.905
```

The ~3% margin between measured and floor is intentional headroom for
fixture-seed noise; we want the gate to fail on real regressions, not on
sampling jitter.

## Interpreting a failing run

A budget breach prints e.g. `nmi 0.8123 < floor 0.9359` to stderr and
exits 1. The fix path depends on which metric moved and in what
direction:

| Symptom                                          | Likely cause                                          |
| ------------------------------------------------ | ----------------------------------------------------- |
| `purity` down, `n_clusters_pred` ≈ truth         | Genuine misassignment — different identities merged    |
| `purity` ≈ 1, `nmi/ari` down, `n_clusters_pred` ≫ truth | Over-fragmentation (threshold too high, or similarity calc regression) |
| All down                                         | A bug — embeddings are being passed in wrong, or normalisation lost |
| Identical-magnitude drops across all metrics     | Test-data drift — re-seed fixtures with new generator output |

If the new numbers are genuinely better and you intend to ratchet the
budgets DOWN (tighten the gate), include the new floors in the same
commit. If the new numbers are worse and you believe it's intentional
(e.g. an embedding-model change), include the rationale in the PR
description — but the harness is one-way; budgets cannot be loosened
without a doc trail.

## Future work

- Add real-LFW fixtures (operator action; see "Synthetic vs LFW" above).
- Add a second fixture set with deliberate adversarial cases (siblings,
  twins, makeup-on/off variations) once the algorithm changes are in
  flight — these benchmarks are most useful for differentiating
  algorithm candidates that all score 1.0 on synthetic data.
- CI provisioning of the LFW fixture is out of scope (large download,
  attribution requirements).
