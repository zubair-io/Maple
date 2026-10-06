"""Run enlargement control and existing RGB-guide native donor experiment."""

import sys
import time

from common import CASES, MODELS, REPO, load, save

sys.path.insert(0, str(REPO / "tools/removal"))
from guided_native_patches import refine

for case in CASES:
    for model in MODELS:
        parent, meta, source, cov, protected, native, guide = load(case, model)
        save(
            case,
            model,
            "bilinear",
            native,
            {
                "description": "Frozen 512 prediction enlarged with bilinear interpolation; no native generated detail."
            },
        )
        start = time.perf_counter()
        # Exclude protected subjects as donors too; any generated protected samples
        # are discarded by the unchanged final coverage.
        prediction, report = refine(source, (cov > 0) | protected, guide)
        report.update(
            seconds=time.perf_counter() - start,
            protectedExcludedAsDonors=True,
            variant="Existing translation-only RGB guidance; no depth/semantic guides or curation",
        )
        save(case, model, "patchmatch", prediction, report)
