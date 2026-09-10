#!/usr/bin/env bash
# audit-linkage.sh — Audit dynamic library dependencies of compiled Linux binaries using readelf.
# Enforces zero-dependency invariant: binaries may only link against libc and libm.
#
# Usage:
#   ./scripts/audit-linkage.sh <path-to-libraw_ffi.so> [glibc|musl]

set -euo pipefail

SO_FILE="${1:-}"
LIBC_TYPE="${2:-glibc}"

if [ -z "$SO_FILE" ] || [ ! -f "$SO_FILE" ]; then
  echo "Error: Dynamic library file '$SO_FILE' does not exist." >&2
  exit 1
fi

if ! command -v readelf &>/dev/null; then
  echo "Error: readelf command not found. Install binutils." >&2
  exit 1
fi

echo "=========================================================="
echo "Auditing dynamic linkage for: $SO_FILE"
echo "Expected libc variant: $LIBC_TYPE"
echo "=========================================================="

READELF_OUTPUT=$(readelf -d "$SO_FILE")
NEEDED_ENTRIES=$(echo "$READELF_OUTPUT" | grep '(NEEDED)' || true)

if [ -z "$NEEDED_ENTRIES" ]; then
  echo "No dynamic (NEEDED) entries found in $SO_FILE (statically linked)."
  exit 0
fi

echo "Discovered NEEDED entries:"
echo "$NEEDED_ENTRIES"
echo "----------------------------------------------------------"

FAILED=0

# Extract clean library names
LIBS=$(echo "$NEEDED_ENTRIES" | sed -E 's/.*\[(.*)\].*/\1/')

while IFS= read -r lib; do
  [ -z "$lib" ] && continue
  case "$LIBC_TYPE" in
    glibc)
      case "$lib" in
        libc.so.6|libm.so.6|ld-linux*|libpthread.so.0|libdl.so.2|librt.so.1)
          echo "  ✓ ALLOWED ($LIBC_TYPE): $lib"
          ;;
        *)
          echo "  ✗ FORBIDDEN DEPENDENCY: $lib" >&2
          FAILED=1
          ;;
      esac
      ;;

    musl)
      case "$lib" in
        libc.musl*|ld-musl*|libc.so*|libm.so*|libdl.so*|libpthread.so*)
          echo "  ✓ ALLOWED ($LIBC_TYPE): $lib"
          ;;
        *)
          echo "  ✗ FORBIDDEN DEPENDENCY: $lib" >&2
          FAILED=1
          ;;
      esac
      ;;

    *)
      echo "Error: Unknown libc type '$LIBC_TYPE'. Choose 'glibc' or 'musl'." >&2
      exit 1
      ;;
  esac
done <<< "$LIBS"

if [ "$FAILED" -ne 0 ]; then
  echo "" >&2
  echo "FAILED: $SO_FILE contains disallowed dynamic dependencies!" >&2
  echo "Zero-dependency linkage invariant violated. Only libc and libm are permitted." >&2
  exit 1
fi

echo "Linkage audit PASSED: $SO_FILE satisfies zero-dependency invariant."
exit 0
