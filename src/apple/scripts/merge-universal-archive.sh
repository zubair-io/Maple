#!/usr/bin/env bash
# merge-universal-archive.sh — merge two single-architecture .xcarchives
# (one arm64, one x86_64) into one universal (arm64+x86_64) .xcarchive.
#
# Why: building "Maple Exposure" as a universal binary in one xcodebuild
# archive invocation was OOMing GitHub's macOS release runner (#3324,
# #3326, #3328) — Whole Module Optimization / SwiftPM's large dependency
# tree, compiled and linked for both architectures in the same process,
# exceeds the runner's memory. Building each architecture as its own
# archive keeps peak memory to one architecture at a time; this script
# does only the lipo merge xcodebuild would otherwise do internally.
#
# Deliberately does NOT re-sign anything: release.yml's "Export with
# Developer ID" step (xcodebuild -exportArchive) already performs a full
# codesigning pass over the whole tree — including nested .appex
# extensions — to produce the real distribution signature. Whatever
# signature these binaries carry going in is replaced wholesale by that
# step, so merging with a now-stale signature is fine; there is no need
# to re-derive entitlements or codesign here.
#
# Scans the ENTIRE archive, not just Products/Applications, and does not
# filter by the executable bit: dSYM DWARF binaries (needed for Intel
# crash symbolication) and some embedded framework/dylib binaries are
# regular files without the +x bit set, so `file`'s Mach-O detection is
# the only filter — the performance cost of running it over every file in
# a release archive is negligible. (jules review, #3331)
#
# Usage: merge-universal-archive.sh <arm64.xcarchive> <x86_64.xcarchive> \
#          <output.xcarchive>
#
# Portability note: this runs under macOS's stock /bin/bash (3.2 — no
# `mapfile`, no `-d ''` on `read`). Deliberately avoids that and every
# GNU-only flag; everything here is newline-delimited, which is safe
# because nothing in this project's build output paths contains a
# literal newline or tab.

set -euo pipefail

ARM64_ARCHIVE="$1"
X86_64_ARCHIVE="$2"
OUT_ARCHIVE="$3"

if [ ! -d "$ARM64_ARCHIVE" ] || [ ! -d "$X86_64_ARCHIVE" ]; then
  echo "ERROR: both input .xcarchive paths must exist" >&2
  exit 1
fi

rm -rf "$OUT_ARCHIVE"
cp -R "$ARM64_ARCHIVE" "$OUT_ARCHIVE"

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

find "$OUT_ARCHIVE" -type f > "$WORKDIR/candidates.txt"

# Note: candidates are discovered from the arm64 tree only, so a
# hypothetical x86_64-exclusive binary with no arm64 counterpart would go
# unmerged. Not a concern for this project today (verified against
# project.pbxproj — every macOS target is universal), but worth knowing
# if that ever changes.
MERGED_COUNT=0
while IFS= read -r OUT_BIN; do
  # -b (brief): file contents only, no leading "path:" — otherwise a path
  # that happened to contain the literal substring "Mach-O" would false-
  # match (jules review, #3331).
  if ! file -b "$OUT_BIN" | grep -q "Mach-O"; then
    continue
  fi

  REL="${OUT_BIN#"$OUT_ARCHIVE"/}"
  X86_64_BIN="$X86_64_ARCHIVE/$REL"

  if [ ! -f "$X86_64_BIN" ]; then
    echo "WARN: no x86_64 counterpart for $REL — leaving arm64-only (unexpected unless this is a build-time-only tool)" >&2
    continue
  fi

  echo "=== Merging: $REL ==="
  # Preserve the original mode: dSYM DWARF binaries and some embedded
  # libraries are legitimately non-executable regular files, so this must
  # not force +x on everything the way a blanket chmod would.
  ORIG_MODE="$(stat -f '%OLp' "$OUT_BIN")"
  MERGED_BIN="$WORKDIR/merged-bin"
  rm -f "$MERGED_BIN"
  lipo -create "$OUT_BIN" "$X86_64_BIN" -output "$MERGED_BIN"
  lipo -info "$MERGED_BIN"
  # rm+mv rather than cp: some SwiftPM-cache-derived binaries land in the
  # archive read-only, and cp onto a read-only destination file fails
  # with Permission denied — unlinking first only needs the containing
  # directory to be writable (jules review, #3331).
  rm -f "$OUT_BIN"
  mv "$MERGED_BIN" "$OUT_BIN"
  chmod "$ORIG_MODE" "$OUT_BIN"
  MERGED_COUNT=$((MERGED_COUNT + 1))
done < "$WORKDIR/candidates.txt"

if [ "$MERGED_COUNT" -eq 0 ]; then
  echo "ERROR: merged zero binaries — something upstream changed (target list, bundle layout)" >&2
  exit 1
fi

echo "Merged $MERGED_COUNT binaries. Universal archive written to $OUT_ARCHIVE"
