#!/usr/bin/env bash
# Publishes the InsightFace buffalo_s ONNX models to a GitHub Release on
# this repo so Maple Self Hosted deploys can fetch them via the
# MAPLE_FACE_*_URL settings. Idempotent — re-running with the same tag
# replaces the uploaded assets and prints fresh SHA256s.
#
# Run once per buffalo_s rotation (typically when you bump InsightFace
# or want to change accuracy/size trade-off). Output is a copy-paste
# ready .env snippet.
#
# Requirements:
#   - python3 + pip3                   (downloads buffalo_s via insightface)
#   - gh CLI, logged in                (uploads release assets)
#   - shasum                           (computes SHA256s)
#
# Env knobs:
#   MAPLE_REPO                  — owner/name (default: read from `gh repo view`)
#   MAPLE_FACE_RELEASE_TAG      — release tag (default: face-models-YYYYMMDD)
#   MAPLE_FACE_RELEASE_TARGET   — branch the release points at (default: main)

set -euo pipefail

REPO="${MAPLE_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
TAG="${MAPLE_FACE_RELEASE_TAG:-face-models-$(date +%Y%m%d)}"
TARGET="${MAPLE_FACE_RELEASE_TARGET:-main}"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

echo "Repo: $REPO"
echo "Tag:  $TAG"
echo

echo "1/4 Downloading buffalo_s via insightface…"
python3 -m pip install --quiet --upgrade insightface onnxruntime
python3 - <<PY
from insightface.app import FaceAnalysis
# `root` lets us drop the cache outside ~/.insightface so this script
# is self-contained.
FaceAnalysis(name='buffalo_s', root='$WORKDIR').prepare(ctx_id=-1)
PY

# insightface drops files at <root>/models/buffalo_s/<file>.onnx
SRC_DIR="$WORKDIR/models/buffalo_s"
[ -f "$SRC_DIR/det_500m.onnx" ] || { echo "❌ det_500m.onnx missing under $SRC_DIR"; exit 1; }
[ -f "$SRC_DIR/w600k_mbf.onnx" ] || { echo "❌ w600k_mbf.onnx missing under $SRC_DIR"; exit 1; }

# Rename to the names face-models.ts expects.
cp "$SRC_DIR/det_500m.onnx"  "$WORKDIR/retinaface.onnx"
cp "$SRC_DIR/w600k_mbf.onnx" "$WORKDIR/mobilefacenet.onnx"

DET_SHA=$(shasum -a 256 "$WORKDIR/retinaface.onnx"     | awk '{print $1}')
REC_SHA=$(shasum -a 256 "$WORKDIR/mobilefacenet.onnx"  | awk '{print $1}')

echo
echo "2/4 Ensuring release $TAG exists on $REPO…"
if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  echo "    Release exists — assets will be replaced."
else
  gh release create "$TAG" \
    --repo "$REPO" \
    --title "Face models — $TAG" \
    --notes "InsightFace buffalo_s ONNX bundle. SHA256s in the script output." \
    --target "$TARGET"
fi

echo
echo "3/4 Uploading assets…"
gh release upload "$TAG" \
  --repo "$REPO" \
  --clobber \
  "$WORKDIR/retinaface.onnx" \
  "$WORKDIR/mobilefacenet.onnx"

URL_BASE="https://github.com/$REPO/releases/download/$TAG"

# Generate the env block that the API reads on boot. face-bootstrap.ts
# eagerly calls loadFaceModels() during startup; with these vars set,
# the first boot after this script runs downloads + caches the models
# under MAPLE_MODEL_DIR (default ~/.maple/models/) and every subsequent
# boot is a no-op.
ENV_BLOCK=$(cat <<ENV
# >>> face-models (managed by scripts/publish-face-models.sh) >>>
MAPLE_FACE_WORKER_ENABLED=true
MAPLE_FACE_RETINAFACE_URL=$URL_BASE/retinaface.onnx
MAPLE_FACE_RETINAFACE_SHA256=$DET_SHA
MAPLE_FACE_MOBILEFACENET_URL=$URL_BASE/mobilefacenet.onnx
MAPLE_FACE_MOBILEFACENET_SHA256=$REC_SHA
# <<< face-models <<<
ENV
)

# Upsert the block into src/api/.env. The script lives at
# src/api/scripts/publish-face-models.sh, so .env is one level up.
ENV_FILE="$(cd "$(dirname "$0")/.." && pwd)/.env"
touch "$ENV_FILE"

echo
echo "4/4 Writing $ENV_FILE…"
if grep -q '^# >>> face-models (managed' "$ENV_FILE"; then
  # Replace the existing block. Use awk so this is portable across
  # macOS/Linux sed flag differences.
  awk -v block="$ENV_BLOCK" '
    BEGIN { skip = 0 }
    /^# >>> face-models \(managed/ { print block; skip = 1; next }
    /^# <<< face-models <<</     { skip = 0; next }
    skip == 0 { print }
  ' "$ENV_FILE" > "$ENV_FILE.tmp" && mv "$ENV_FILE.tmp" "$ENV_FILE"
  echo "    Replaced existing face-models block."
else
  # Append a fresh block.
  printf '\n%s\n' "$ENV_BLOCK" >> "$ENV_FILE"
  echo "    Appended fresh face-models block."
fi

echo
echo "✅ Done. Restart the API and the face worker will download the"
echo "   models on first boot. Inspect via /settings/enrichment."
echo
echo "   Wrote into $ENV_FILE:"
echo "──────────────────────────────────────────────────────────────────────"
echo "$ENV_BLOCK"
echo "──────────────────────────────────────────────────────────────────────"
