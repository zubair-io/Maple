# Rejected broad increase exception

The initial chart target passes and all 28 AMaZE tests pass, but a physical counterexample invalidates the broad exception: test_0000/nr_luminance_max returns to max Delta E 51.89043209976267, above the unchanged 50.90 limit; source35 passes this case.

Stopped the 91-case experiment after 34 completed comparisons rather than spend more time on a rejected hypothesis. All completed reports, exact source patch, unit logs and candidate hashes are preserved; referenced immutable inputs were independently revalidated after stopping. Only the owned experimental driver and its children were terminated. No production change adopted.

The next trial retains the green-support guard whenever the reconstructed channel remains within the nearest measured target samples. It permits a value increase only below every measured target sample. Both the chart and the Hasselblad counterexample must pass before expanded controls.
