#!/usr/bin/env bash
# test_halo_detection.sh — halo-overshoot detector on a synthetic disk.
#
# Renders four variants of a dark-disk-on-light-background scene through
# the pipeline:
#   control   — default model (no clarity, no texture, no dehaze).
#   clarity   — clarity=+100.
#   texture   — texture=+100.
#   dehaze    — dehaze=+100.
# Each variant dumps every pipeline stage; `halo_check.py` reports the
# overshoot percentage at the disk edge.
#
# Diagnostic, not a gate — exits 0 unless the build fails.
#
# Env overrides:
#   OUT_DIR    Working root. Default: /tmp/maple-halo-*.
#   KEEP_TMP   Non-empty -> keep OUT_DIR after exit for inspection.
#   STAGE      Which stage's EXR to scan (default 16_agx).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

STAGE="${STAGE:-16_agx}"
KEEP_TMP="${KEEP_TMP:-}"

if [[ -n "${OUT_DIR:-}" ]]; then
  mkdir -p "$OUT_DIR"
  WORK="$OUT_DIR"
  CLEANUP=""
else
  WORK="$(mktemp -d -t maple-halo-XXXXXXXX)"
  CLEANUP="$WORK"
fi
cleanup() {
  if [[ -n "$CLEANUP" && -z "$KEEP_TMP" ]]; then
    rm -rf "$CLEANUP"
  fi
}
trap cleanup EXIT

echo "# Building maple-cli with --features stage-dump..."
(
  cd "$REPO_ROOT/src/raw-pipeline"
  cargo build -p maple-cli --features stage-dump --release >/dev/null
)
MAPLE_CLI="$REPO_ROOT/src/raw-pipeline/target/release/maple-cli"

# Write the three XMP variants on the fly. Minimal sidecars — only the
# field under test deviates from default.
mkdir -p "$WORK/xmp"
cat > "$WORK/xmp/clarity.xmp" <<'EOF'
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
                     crs:Clarity2012="+100"/>
  </rdf:RDF>
</x:xmpmeta>
EOF

cat > "$WORK/xmp/texture.xmp" <<'EOF'
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
                     crs:Texture="+100"/>
  </rdf:RDF>
</x:xmpmeta>
EOF

cat > "$WORK/xmp/dehaze.xmp" <<'EOF'
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
                     crs:Dehaze="+100"/>
  </rdf:RDF>
</x:xmpmeta>
EOF

cat > "$WORK/xmp/control.xmp" <<'EOF'
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"/>
  </rdf:RDF>
</x:xmpmeta>
EOF

declare -a VARIANTS=("control" "clarity" "texture" "dehaze")
for v in "${VARIANTS[@]}"; do
  sub="$WORK/$v"
  mkdir -p "$sub/stages"
  echo "# Rendering halo disk — variant $v"
  MAPLE_STAGE_DUMP="$sub/stages" "$MAPLE_CLI" synthetic \
    --kind halo-disk \
    --width 256 --height 256 \
    --params "$WORK/xmp/$v.xmp" \
    --out "$sub/disk.png"
done
echo ""

for v in "${VARIANTS[@]}"; do
  echo "# === variant: $v ==="
  python3 "$SCRIPT_DIR/halo_check.py" "$WORK/$v/stages" \
    --stage "$STAGE" \
    --json "$WORK/$v/halo.json"
  echo ""
done

echo ""
echo "# Diagnostic outputs:"
for v in "${VARIANTS[@]}"; do
  echo "#   $v:  stages=$WORK/$v/stages  json=$WORK/$v/halo.json"
done
if [[ -n "$KEEP_TMP" ]]; then
  echo "# (kept on disk because KEEP_TMP is set)"
elif [[ -n "$CLEANUP" ]]; then
  echo "# (will be cleaned up on exit — re-run with KEEP_TMP=1 to inspect)"
fi
