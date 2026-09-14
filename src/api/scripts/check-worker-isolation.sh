#!/usr/bin/env bash
# Check that worker-main code path has no inline-abortable native imports.
# Part of #884 worker isolation — ensures onnxruntime/heic-convert are
# only loaded in isolated child processes, never in worker-main's address space.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_SRC="$SCRIPT_DIR/../src"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m' # No Color

EXIT_CODE=0

echo "=== Checking worker-main code path for inline-abortable native imports ==="
echo ""

# Function to check for imports in non-test files
check_import() {
  local pattern=$1
  local name=$2
  local paths=$3

  echo -n "Checking for '$name' imports in worker-main path... "

  # Search for imports, excluding test files and child process files
  local matches=$(grep -r "$pattern" $paths --include="*.ts" \
    --exclude="*.test.ts" \
    --exclude="*.child.ts" \
    --exclude="imgdecode.child.ts" \
    --exclude="raw_ffi.child.ts" \
    --exclude="face-pool.child.ts" \
    2>/dev/null || true)

  if [ -z "$matches" ]; then
    echo -e "${GREEN}✓ OK${NC}"
    return 0
  else
    echo -e "${RED}✗ FAIL${NC}"
    echo "  Found inline imports:"
    echo "$matches" | sed 's/^/    /'
    EXIT_CODE=1
    return 1
  fi
}

# Check for sharp imports — retired from src/api entirely (#3500); no
# exception carve-out needed any more (face-detector.ts no longer imports
# it at all).
check_import "from 'sharp'" "sharp" \
  "$API_SRC/workers $API_SRC/indexer $API_SRC/enrichment"

# Check for onnxruntime imports
check_import "from 'onnxruntime" "onnxruntime-node" \
  "$API_SRC/workers $API_SRC/enrichment"

# Check for heic-convert imports
check_import "from 'heic-convert'" "heic-convert" \
  "$API_SRC/workers $API_SRC/indexer"

echo ""
echo "=== Verifying isolation architecture ==="
echo ""

# Verify thumbnailer routes through pools
THUMBNAILER="$API_SRC/indexer/thumbnailer.ts"
FFI_POOL_COUNT=$(grep -c 'ffiPool()' "$THUMBNAILER" || echo 0)
IMGDECODE_COUNT=$(grep -c 'renderImageThumbToFile' "$THUMBNAILER" || echo 0)

echo "Thumbnailer isolation:"
echo "  - FFI pool calls (RAW): $FFI_POOL_COUNT"
echo "  - imgdecode pool calls (bitmap): $IMGDECODE_COUNT"

if [ "$FFI_POOL_COUNT" -ge 1 ] && [ "$IMGDECODE_COUNT" -ge 1 ]; then
  echo -e "  ${GREEN}✓ Thumbnailer properly isolated${NC}"
else
  echo -e "  ${RED}✗ Thumbnailer not properly isolated${NC}"
  EXIT_CODE=1
fi

echo ""

# Verify previewer routes through pools
PREVIEWER="$API_SRC/indexer/previewer.ts"
FFI_POOL_COUNT=$(grep -c 'ffiPool()' "$PREVIEWER" || echo 0)
IMGDECODE_COUNT=$(grep -c 'renderImageThumbToFile' "$PREVIEWER" || echo 0)

echo "Previewer isolation:"
echo "  - FFI pool calls (RAW): $FFI_POOL_COUNT"
echo "  - imgdecode pool calls (bitmap): $IMGDECODE_COUNT"

if [ "$FFI_POOL_COUNT" -ge 1 ] && [ "$IMGDECODE_COUNT" -ge 1 ]; then
  echo -e "  ${GREEN}✓ Previewer properly isolated${NC}"
else
  echo -e "  ${RED}✗ Previewer not properly isolated${NC}"
  EXIT_CODE=1
fi

echo ""

# Verify face-pool child isolation
if [ -f "$API_SRC/enrichment/face-pool.child.ts" ]; then
  echo -e "Face worker isolation: ${GREEN}✓ Child process exists${NC}"
else
  echo -e "Face worker isolation: ${RED}✗ Child process missing${NC}"
  EXIT_CODE=1
fi

echo ""
echo "=== Summary ==="
if [ $EXIT_CODE -eq 0 ]; then
  echo -e "${GREEN}✓ All checks passed${NC}"
  echo "Worker-main has no inline-abortable native imports."
  echo "All heavy native code (onnxruntime, heic-convert) is isolated in child processes."
else
  echo -e "${RED}✗ Some checks failed${NC}"
  echo "Worker-main may have inline-abortable native imports that could crash the entire tier."
fi

exit $EXIT_CODE
