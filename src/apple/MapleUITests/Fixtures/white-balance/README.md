# White-balance authoring fixture

`grey-auto-web.xmp` is the actual **Download XMP** result from the Web Color → Basic → White balance → Auto flow on `../synthetic/grey-l018-rggb.dng`. It was produced with a release WASM build using `gpu,parallel`, then saved through the normal Web serializer. The original DNG is unchanged.

`WhiteBalanceAuthoringParityTests` runs the Apple FFI estimator on the same DNG, serializes its WB-only Auto result, and requires the numerical pair, source, name, scale and algorithm version to match this sidecar. Both sidecars must then render byte-identically through the linked Metal chain on a non-uniform scene-linear buffer. Missing fixtures, failed analysis, absent GPU output and flat output fail the gate.

Regenerate through the real Web control and Download XMP action when the versioned AUTO estimator changes; review the new pair and version together.
