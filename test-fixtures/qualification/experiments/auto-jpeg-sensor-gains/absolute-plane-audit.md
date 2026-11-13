# Gain-map image-plane indexing audit

[Adobe DNG SDK implementation](https://android.googlesource.com/platform/external/dng_sdk/+/refs/heads/android14-prebuilt-test/source/dng_gain_map.cpp) selects a gain-map plane from the absolute image-plane number, capped at the last map plane. The opcode area controls which image planes are affected; it does not renumber the lattice planes. Correct the new sensor gain-map path to match that behavior and the existing OpcodeList3 path.

A nonzero-start-plane witness distinguishes the two behaviors: an opcode affecting image planes1/2 with map gains2/3/4 must apply3/4, not2/3; image plane0 remains unaffected. A one-plane map broadcasts its single gain to every affected image plane. All7sensor-map checks pass, including native full-frame/tile parity.

This correction does not change any current corpus gain lookup: `corpus-audit.json` records that only0015 has OpcodeList2gain maps; all four use image plane0 and one map plane. The current full physical image qualification remains explicitly attributed to its frozen f34e22e324 binary. No new color pass is claimed for this API correctness fix. Output37,fit7,original sources and all quality limits remain unchanged.
