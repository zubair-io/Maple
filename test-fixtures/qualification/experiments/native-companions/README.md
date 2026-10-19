# Qualified native reference companions

This three-case chunk corrects unequal resize kernels without changing the
renderer or numerical budgets. It uses the existing native-pair protocol.
The original reference PNGs, RAWs, canonical sidecars and source manifest stay
intact. Every qualified down capture has exactly the original RGB pixels.

`qualification-report.json` records input hashes, native/down dimensions,
all capture-added metadata changes and the qualifier source identity.
`matched-results.json` records canonical three-case before/after comparisons:
two failures clear, the existing passing case remains passing, and no new
failed case appears. These are comparison-protocol repairs, not renderer fixes.

`recapture-identity-diagnostics.json` also preserves the rejected test_0000
captures. They differ in a few RGB values and are not silently accepted with
a new tolerance. Adobe Version plus recognized inactive Glow/Reshape controls
change in capture metadata; the complete authored-state verifier accepts only
its existing explicit bookkeeping/inactive exceptions. Unknown active changes
still fail. Native and down metadata within each qualified pair match exactly.

The runnable full overlay manifest and private Adobe assets are retained at:
`/Users/riabuz/.codex/color-suite-evidence/5000/resize-family-diagnostic/qualified-manifest-v3.json`.
They are separate from the original-protocol baseline and primary fixture tree.
The tint-reference proposal remains a separate pending user decision.
