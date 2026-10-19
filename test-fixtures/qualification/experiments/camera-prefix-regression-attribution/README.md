# Source35 regression attribution

All29 newly failing cases pass the frozen source33 control. Adding the positive-chroma green support guard produces16 failures; adding metadata-balanced AMaZE and local recovery produces13 more. Exact binaries were hash-checked before use; the full input sets were rechecked by each driver. These are attribution cohorts, not complete final gates.

The first candidate for repair is the guard: a full source35 stage trace for the synthetic chart shows it blocks a needed increase in reconstructed chroma. A selective guard that protects against unsupported reductions while retaining chroma-line value increases is being tested separately. No rollback or production adoption is claimed here.
