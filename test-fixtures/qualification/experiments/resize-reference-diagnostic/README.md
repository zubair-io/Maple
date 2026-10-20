# Resize-protocol diagnostic — one case

For `test_0007/clarity_max`, Photoshop saved native and 4000-pixel outputs
from the same opened document with complete verified Adobe settings. The new
down PNG's decoded RGB pixels are **identical** to the original canonical
reference, despite container metadata/hash differences. The original RAW,
XMP and PNG hashes were revalidated unchanged; the staged RAW copy is also
byte-identical to the original.

The unchanged captured-main candidate compared to the down reference gives
maximum Delta E 42.248989120652645, above the unchanged ceiling 42.1.
Reducing both native images with the comparator's existing Lanczos kernel
gives 40.90517739459689, below that ceiling. Mean error changes from
8.333995633265664 to 8.315920680305425. The reference export uses
BICUBICSHARPER while the legacy candidate reduction uses Lanczos; this
single control demonstrates a maximum-error breach due to unequal reduction
protocols. It does not establish the cause of other cases.

`results.json` preserves every metric and file hash. No production comparator,
manifest, budget or original reference was changed. These alternate-protocol
results are not counted as cleared canonical failures. Native and down captures
remain local under `/Users/riabuz/.codex/color-suite-evidence/5000/resize-reference-diagnostic`.
