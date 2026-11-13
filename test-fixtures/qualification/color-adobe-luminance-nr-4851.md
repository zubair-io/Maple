# Explicit Adobe luminance-NR subcontrols — #4851

## Defect and correction

The complete Camera Raw authoring audit in #4789 rejected all 18 active
`nr_luminance_max` cases. Their Adobe authoring sidecars omitted luminance-NR
Detail and Contrast, even though Adobe recorded effective values in the
rendered PNGs. An inherited Adobe default is not an explicit rendering recipe.

The authoring tool now supplies Detail 50 and Contrast 0 when omitted and
preserves existing attribute or element overrides. Active luminance NR requires
both controls in the authored recipe and capture. Historical omissions remain
valid only when `LuminanceSmoothing` is zero. An explicitly recorded inactive
value must still match its authoring value.

## Executable checks

Six new tests produce nine failing assertions against unchanged main. After
the correction, all **19 reference-tool tests pass**, including the existing
batch cleanup and white-balance controls. The new module uses the existing
CI discovery pattern, so the exact CI command executes all 19:

```sh
python3 -m unittest discover -s src/scripts/acr-reference -p 'test_reference*.py'
```

Ruff format/lint, whitespace and file-headroom checks pass. The rendering
pipeline, original sidecars, installed manifest and numerical budgets are
unchanged.

## Genuine Adobe recaptures

Photoshop 27.11.0 / Camera Raw 18.7 rendered all 18 cases from byte-identical
staged RAW copies and newly prepared Adobe sidecars. Each sidecar adds exactly
the two missing properties; every previous Camera Raw property remains equal.
Each case produced a native full PNG and its companion at a maximum 4000-pixel
long edge. Both outputs pass the complete authored/effective CRS comparison,
have identical effective CRS state, retain expected geometry and decode with
valid PNG checksums.

`test_0018` initially failed to open from the network volume. Its byte-identical
RAW and sidecar opened successfully from local staging, where the same capture
script produced both outputs. The failed attempt and successful local retry
are preserved. Photoshop closed all capture documents.

All **614,116,208 native pixels** were compared with the prior references:

- **16 cases are pixel-identical.**
- `test_0000`: 455 pixels differ, by at most one 8-bit channel level.
- `test_0003`: 459 pixels differ, by at most one 8-bit channel level.

The original RAWs, Maple sidecars, Adobe authoring sidecars and reference PNGs
all retain their recorded SHA-256 hashes. Old captures were not edited to add
missing metadata. New output and authoring hashes are recorded separately.

## Corpus audit and integration boundary

The new verifier plus #4789's complete-CRS checker accepts **758/776** cases
before migration and **776/776** with the 18 newly captured recipes/references
overlaid. A second independent metadata audit also passes all 776. The overlay
retains each case's original comparison tiers, original RAW and Maple XMP.

This closes an authoring/measurement defect; it clears no rendering-budget
failure. The installed manifest remains unchanged while protocol/corpus
integration proceeds under #3678. The physical color corpus still has failures
on main, and this report does not establish a passing rendering gate. CI and
review of this authoring-tool change remain pending.

Capture manifests, before/after audits, pixel deltas, both Photoshop logs,
original/output hashes and `migration-overlay.json` are retained under
`/Volumes/Projects/maple-color-gate-20261015/adobe-luminance-nr-4851/`.
