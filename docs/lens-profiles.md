# Imported lens profiles

Maple can import a user-owned `.lcp` calibration in the Web and Windows lens controls. Importing first reports the actual camera/lens match and selected calibration samples. Choosing **Use profile** records one undoable sidecar edit. Distortion, lateral chromatic aberration, and vignetting have independent strengths; a family without calibration stays disabled. Corrections run in the shared scene-linear decode stage before the default crop, with the same prefix consumed by the GPU renderer.

DNG OpcodeList3 corrections take priority over an imported profile. Corrections are never compounded. Switching the master control off, or setting all strengths to zero, requires no external profile bytes.

## Matching and supported models

The resolver requires the camera make, camera model, and lens identity to match the calibration. Case and whitespace normalization are allowed; there is no fuzzy matching or guessed body alias. RAW and JPEG calibrations are distinct.

The supported model is legacy `PerspectiveModel`, including its version 1/2 attribute and RDF element encodings. It includes the three-term radial and two-term tangential distortion polynomial, relative red/green and blue/green chromatic models, and three-term radial illumination. Unknown terms, duplicate models, newer `Version2PerspectiveModel`, fisheye, and piecewise encodings remain unsupported. An incomplete model cannot silently become a shorter polynomial.

Focal coordinates use the maximum calibration dimension; image centers use their respective dimensions. The geometric model maps corrected output coordinates to recorded source coordinates. Vignetting divides by the illumination polynomial and preserves scene-linear headroom.

Calibration selection interpolates in log focal length and reciprocal focus distance, plus APEX aperture for vignetting. Duplicate settings use the smallest reported fitting error, then a stable content ordering. The UI reports sample weights, unsupported records, missing metadata, out-of-range settings, and calibration aspect differences. An approximation requires a separate explicit acceptance; it cannot bypass a camera/lens mismatch or an unsupported model.

## Persistence

`papp:LensProfile` stores `lcp1:<BLAKE3 digest>` for the exact imported UTF-8 bytes. `lcp1-ack:<digest>` also records the user's approximation acceptance. The version pins Maple's interpretation of the document. Original RAWs are never modified.

Hosted stores imported bytes in IndexedDB. Windows stores them under `%LOCALAPPDATA%/Maple/LensProfiles`. Self Hosted uploads them to the authenticated server cache and restores missing browser copies from that server. A required profile missing from the available cache produces an explicit error; Maple does not substitute another profile. Back up the original LCP with the photo sidecars when moving a library between independent installations.

Batch sync preserves each target's own profile selection. A source capture's calibration and approximation acceptance are not automatically transferred to another capture. Complete export snapshots retain their authored profile reference. Web, Windows, and Self Hosted restore the exact cached profile before rendering that snapshot, including after a worker or application restart; later editor or sidecar changes do not alter queued optical intent.

No third-party profile pack is redistributed. Import support does not establish a licensed distribution catalog or promote camera qualification tiers. Apple import UI, newer LCP model families, and native detail tiles for warped coordinates are outside this implementation's supported surface.

## Manual geometry and qualification

Web and Windows provide five independent manual controls: horizontal/vertical perspective, clockwise rotation, area-preserving aspect, and centered scale. The shared CPU and WGSL paths apply the transform after display rendering and before crop. Masks are evaluated in the original frame and move with the rendered image; Web mask handles use the matching forward/inverse transform. Identity geometry preserves the existing output. GPU sessions reuse their scratch textures as slider values change, and manual controls do not invalidate the decode cache.

Native detail patches currently require identity manual geometry and no active imported correction. Transformed images retain the complete sized canvas. Apple control UI and its legacy CPU/GPU crop integration are not implemented here; shared schema and ABI mirrors only preserve interoperability.

Synthetic tests exercise deterministic optical selection, XMP persistence, orientation, crop/mask coordinates, and CPU/WGSL geometry parity. They do not establish the issue's 95% camera/lens coverage or its reference-machine interaction budget. The physical RAW corpus and `test-fixtures/references/manifest.json` are still required before those qualification gates can pass. No camera or capability qualification is promoted by this change.

## References

The [Adobe Lens Profile Creator guide](https://www.adobe.com/special/photoshop/camera_raw/lensprofile_creator/lensprofile_creator_userguide.pdf) describes the calibration workflow. Mathematical conventions were checked against the independent primary implementations in [RawTherapee](https://github.com/RawTherapee/RawTherapee/blob/dev/rtengine/lcp.cc), [AliceVision](https://github.com/alicevision/AliceVision/tree/develop/src/aliceVision/lensCorrectionProfile), and the [Lensfun LCP converter](https://github.com/lensfun/lensfun/blob/master/apps/lensfun-convert-lcp). Tests use authored synthetic calibration coefficients; installed third-party profiles are read-only validation inputs and are not committed.
