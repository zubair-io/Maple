# Complete Custom white balance for Adobe references — #4784

## Scope

The reference generator can receive a Maple sidecar that authors only one
Custom white-balance axis. Adobe reference preparation now supplies the missing
Temperature or Tint from the same fixture's effective As Shot baseline PNG.
It preserves the authored axis, unknown XMP content and original Maple sidecar.
No camera-independent white-balance value is substituted.

An absent or invalid recorded baseline makes preparation fail. Verification
also rejects an incomplete expected Custom pair before opening an output PNG.
Already complete Custom pairs and other white-balance modes retain their
behavior. This changes reference tooling; no renderer, numerical budget,
original RAW, original sidecar or installed reference image is modified.

## Before and after

On main `d0689ff4cea06b320910cc703a90fd8241c24808`, a real temporary tint-only
XMP is copied to an Adobe sidecar without Temperature. The verifier accepts a
PNG containing that incomplete expected pair. The assertion requiring both
axes fails. The original temporary sidecar remains byte-identical.

With the repair, all **12 reference-settings tests** pass. They cover omitted
and authored controls, complete and partial white balance, invalid/missing
recorded settings, unchanged source bytes, effective PNG metadata, manifest
preparation, and rejecting an incomplete expected pair. The existing **12
comparator tests** also pass.

Ruff lint and formatting, file headroom and whitespace checks pass. Code
generation and a repeat produce no generated changes or drift. The existing
Rust CI workflow already executes the reference-settings and comparator suites
when these reference-tool files change.

A read-only audit prepares all **776 physical corpus sidecars** into a temporary
directory. It completes **34 partial Custom pairs**; all 776 resulting settings
match the Adobe authoring sidecars already used by the captured corpus. Every
original Maple sidecar is unchanged. This audit uses the baseline locations
in the frozen manifest, including Sony's separate capture directory. The first
audit attempt assumed a single capture root and correctly failed on Sony's
missing baseline; correcting the audit's input lookup required no production
code change.

## Standalone copier review regression

Review identified the second caller of the preparation helper:
`write_xmp.py --canonical/--target`. On the first PR revision, a canonical
tint-only case fails after **21 files** have already been written. The
standalone command now accepts `--as-shot-baseline` for the destination photo,
and validates every prepared sidecar before writing any file. The same PNG
metadata reader serves both this command and the orchestrator.

The regression runs the real CLI over the full 43-case matrix. Missing or
invalid As Shot settings leave both new and existing destinations untouched;
a valid baseline completes the batch, preserves authored tint and source
bytes, and retains existing unrelated output. The 12 reference tests, all
12 comparator tests and the 776-sidecar physical settings audit pass again
after the fix. Generation introduces no changes.

The command logs, original failing control, per-case source hashes, complete
settings comparison and replay scripts are preserved in
`/Volumes/Projects/maple-color-gate-20261015/adobe-custom-wb-4784/`.

This is a reference-preparation correction. It does not claim that a rendered
color comparison was cleared or that the full physical corpus passes. The
session's authorized exception for documented existing failures on main still
requires green CI and resolved review before merge. Parent investigations
#2333 and #3678 remain open.
