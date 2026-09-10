# Imported lens profiles

Maple can apply a user-owned `.lcp` calibration to a RAW alongside the corrections embedded in the file. The profile is imported once, identified by the hash of its exact bytes, and selected per photo through one sidecar field. Distortion, lateral chromatic aberration and vignetting keep their independent strengths; a family the calibration does not cover stays inert. Corrections run in the shared scene-linear decode stage before the default crop, on the same prefix the GPU renderer consumes.

Two invariants hold everywhere:

- A DNG `OpcodeList3` embedded in the RAW takes priority over an imported profile. Corrections are never compounded.
- A profile the sidecar names but that is not in the local cache is an explicit error. Maple never substitutes another profile or silently renders without correction.

Switching the master toggle off, or setting every strength to zero, needs no external profile bytes at all.

## Matching and supported models

The resolver requires the camera make, camera model and lens identity to match the calibration; case and whitespace are normalised, but there is no fuzzy matching and no guessed body alias. RAW and JPEG calibrations are distinct.

The supported model is the legacy `PerspectiveModel`, in both its version 1/2 attribute and RDF element encodings: the three-term radial and two-term tangential distortion polynomial, the relative red/green and blue/green chromatic models, and three-term radial illumination. Unknown terms, duplicate models, `Version2PerspectiveModel`, fisheye and piecewise encodings are unsupported and reported as such. An incomplete model never degrades into a shorter polynomial.

Calibration selection interpolates in log focal length and reciprocal focus distance, plus APEX aperture for vignetting. When a frame falls outside the calibrated range the resolver still resolves, but reports the result as an approximation; applying one requires a separate, explicit acceptance recorded in the sidecar. Acceptance covers approximation only. It cannot bypass a camera/lens mismatch or an unsupported model.

## Persistence

`papp:LensProfile` carries `lcp1:<BLAKE3>` for the exact imported UTF-8 bytes, or `lcp1-ack:<BLAKE3>` when the user also accepted the resolver's approximations. The `lcp1` prefix pins Maple's interpretation of the document. The field is free-form text on every host, omitted when empty, and passes through the Apple writer verbatim so a selection made on Web or Windows survives a Mac edit.

The field is in raw-core's `NON_COPYABLE_FIELDS`. A profile id names the calibration for the lens one specific frame was shot with, so paste, batch sync and presets never carry it; each photo resolves its own profile from its own EXIF. Preset documents that already contain one are preserved as string data and neither captured nor applied.

Self Hosted keeps imported bytes in the server cache (`POST /api/lens-profiles`, `GET /api/lens-profiles/:digest`, see `server-api.md`). The isolated render child restores the selected profile from that cache before every develop or histogram call, so queued exports and cold worker restarts render the same pixels the editor showed.

On the Web (#3479) the render worker keeps every imported document in IndexedDB (`maple-lens-profiles`, keyed by digest — see `caching.md`) and re-registers it into raw-core's process cache before any request whose sidecar names it: decode, live-session open and render, export. Hosted has only that copy; Self Hosted also uploads the same file to `POST /api/lens-profiles` on import and, when the browser copy is missing (a new browser, cleared site data), the worker asks the main thread to restore it from `GET /api/lens-profiles/:digest` first. A profile that no cache can supply is reported to the Lens Corrections panel as an explicit error; raw-core refuses that render rather than skipping the correction. The panel's import block (`lens-profile-import`) shows the resolver's camera/lens match, the families the calibration covers, the interpolated samples, reported approximations and unsupported records; **Use profile** writes `lcp1:<digest>` as one undoable edit, and approximations can only be applied after the separate acceptance checkbox, which writes `lcp1-ack:<digest>`. Each strength slider disables for a family the calibration does not cover. `maple-cli render --lens-profile <file.lcp> [--acknowledge-lens-approximation]` registers a document for one headless render and prints the resolver's evidence; `maple-cli inspect <file.lcp>` prints the parsed calibration inventory.

Windows (`%LOCALAPPDATA%/Maple/LensProfiles`) storage and its import UI are the remaining slice of #3395. Apple import UI, newer LCP model families and native-detail tiles for warped coordinates are outside the supported surface.

No third-party profile pack is redistributed. Import support does not establish a licensed distribution catalog or promote camera qualification tiers.

## References

The [Adobe Lens Profile Creator guide](https://www.adobe.com/special/photoshop/camera_raw/lensprofile_creator/lensprofile_creator_userguide.pdf) describes the calibration workflow. Mathematical conventions were checked against the independent implementations in [RawTherapee](https://github.com/RawTherapee/RawTherapee/blob/dev/rtengine/lcp.cc), [AliceVision](https://github.com/alicevision/AliceVision/tree/develop/src/aliceVision/lensCorrectionProfile) and the [Lensfun LCP converter](https://github.com/lensfun/lensfun/blob/master/apps/lensfun-convert-lcp). Tests use authored synthetic calibration coefficients; installed third-party profiles are read-only validation inputs and are not committed.
