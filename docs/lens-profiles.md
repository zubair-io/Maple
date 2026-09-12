# Lens corrections

Maple corrects lens distortion, lateral chromatic aberration and vignetting from three sources, in a fixed order of precedence:

1. **Corrections embedded in the RAW** (a DNG `OpcodeList3`). These are the maker's own model for that exact lens and body and always win. They are never compounded with anything below.
2. **An explicit selection** in the sidecar's `papp:LensProfile`: an imported LCP (`lcp1:` / `lcp1-ack:`, described under "Imported lens profiles" below) or a bundled lens picked by hand (`lensfun1:<maker>/<lens>@<mount>`).
3. **The automatic match** from the bundled Lensfun database, when the RAW's EXIF make, model and lens name identify a calibrated lens.

The master toggle (`crs:LensProfileEnable="0"`) turns all three off, and the three strength sliders scale each family independently. An automatic match writes nothing to the sidecar, like Auto Profile: the render is reproducible from the database snapshot pinned in the build.

## Bundled Lensfun database

raw-core ships a snapshot of the [Lensfun](https://github.com/lensfun/lensfun) calibration database (1,565 lenses, 1,051 bodies, 299 mounts at commit `12f5976`, 2026-09-11), converted at build time by `src/scripts/convert_lensfun_db.py` into `raw-core/src/lens_profile/lensfun/db.bin` and included into every host, so the xcframework, the Windows DLL, the API dylib and the wasm bundle all correct the same lenses the same way. The data is CC BY-SA 3.0; `ATTRIBUTION.md` next to the bundle carries the licence, the source commit and the conversion rules, and `COVERAGE.md` the counts and the entries that were skipped (non-rectilinear projections, placeholder lenses).

Matching is exact after canonicalisation, never fuzzy: names are lowercased, a leading maker prefix is dropped, `f/` becomes `f` and whitespace is removed, so a body's `FE 24-70mm F4 ZA OSS` meets Lensfun's `FE 24-70mm f/4 ZA OSS`. The camera resolves to a mount and a crop factor; the lens must sit on that mount or on one the mount lists as compatible (adapted glass), and a calibration made on a smaller sensor is never used for a larger one. When Lensfun lists a lens once per crop factor, the set calibrated closest to the camera's sensor is used. An ambiguous name (`24-70mm`), an unknown body or an unknown lens means no correction and no error; `maple-cli inspect <raw>` prints what matched and every bundled lens the body can carry, and `maple-cli render --lens auto|off|<slug>` chooses.

The models convert into raw-core's own calibration form by coefficient rescaling, the way `liblensfun` does it: both normalise the radius by the focal length, `ptlens` and TCA `poly3` need the odd-power radial terms `Perspective::radial_odd`, and the `1 − k1` (or `1 − a − b − c`) zoom factor is absorbed the way `liblensfun` absorbs it. `test-fixtures/qualification/lensfun-reference.json` holds `liblensfun`'s own answers for six camera/lens/focal cases, and `lens_profile::lensfun::tests_parity` reproduces them to 0.05 px and 1e-4 in gain. `src/scripts/test_lensfun_vs_lcp.sh` compares the bundled calibration with Adobe's LCP for the same lens on the Sony fixture, gated by the ceilings in `test-fixtures/qualification/lensfun-vs-lcp.json`.

A shot outside a lens's calibrated focal, aperture or distance range is clamped to the nearest sample and reported in the render evidence as an approximation; for the bundled database that is applied as-is, since it is the product default, whereas an imported LCP still needs the user's explicit acknowledgement. A vignetting polynomial that crosses zero before this sensor's corners is dropped for that shot and reported.

## Imported lens profiles

Maple can apply a user-owned `.lcp` calibration to a RAW alongside the corrections embedded in the file. The profile is imported once, identified by the hash of its exact bytes, and selected per photo through one sidecar field. Distortion, lateral chromatic aberration and vignetting keep their independent strengths; a family the calibration does not cover stays inert. Corrections run in the shared scene-linear decode stage before the default crop, on the same prefix the GPU renderer consumes.

Two invariants hold everywhere:

- A DNG `OpcodeList3` embedded in the RAW takes priority over an imported profile. Corrections are never compounded.
- A profile the sidecar names but that is not in the local cache is an explicit error. Maple never substitutes another profile or silently renders without correction.

Switching the master toggle off, or setting every strength to zero, needs no external profile bytes at all.

## Matching and supported models

The resolver requires the camera make and lens identity to match the calibration, and the camera model too whenever the profile names one; a profile that names no body (Adobe ships most mirrorless lens profiles that way, make plus lens only) applies to every body of that make. Case and whitespace are normalised, but there is no fuzzy matching and no guessed body alias. RAW and JPEG calibrations are distinct.

The supported model is the legacy `PerspectiveModel`, in both its version 1/2 attribute and RDF element encodings: the three-term radial and two-term tangential distortion polynomial, the relative red/green and blue/green chromatic models, and three-term radial illumination. Unknown terms, duplicate models, `Version2PerspectiveModel`, fisheye and piecewise encodings are unsupported and reported as such. An incomplete model never degrades into a shorter polynomial.

Calibration selection interpolates in log focal length and reciprocal focus distance, plus APEX aperture for vignetting. A RAW that records no subject distance (most bodies do not) is treated as focused at infinity, as Adobe does; a missing focal length or aperture stays a reported approximation. Profiles without `ImageWidth`/`ImageLength` are the normal Adobe shape and are normalised by `SensorFormatFactor`, so their absence is not an approximation either. When a frame falls outside the calibrated range the resolver still resolves, but reports the result as an approximation; applying one requires a separate, explicit acceptance recorded in the sidecar. Acceptance covers approximation only. It cannot bypass a camera/lens mismatch or an unsupported model.

## Persistence

`papp:LensProfile` carries `lcp1:<BLAKE3>` for the exact imported UTF-8 bytes, or `lcp1-ack:<BLAKE3>` when the user also accepted the resolver's approximations. The `lcp1` prefix pins Maple's interpretation of the document. The field is free-form text on every host, omitted when empty, and passes through the Apple writer verbatim so a selection made on Web or Windows survives a Mac edit.

The field is in raw-core's `NON_COPYABLE_FIELDS`. A profile id names the calibration for the lens one specific frame was shot with, so paste, batch sync and presets never carry it; each photo resolves its own profile from its own EXIF. Preset documents that already contain one are preserved as string data and neither captured nor applied.

Self Hosted keeps imported bytes in the server cache (`POST /api/lens-profiles`, `GET /api/lens-profiles/:digest`, see `server-api.md`). The isolated render child restores the selected profile from that cache before every develop or histogram call, so queued exports and cold worker restarts render the same pixels the editor showed.

On the Web (#3479) the render worker keeps every imported document in IndexedDB (`maple-lens-profiles`, keyed by digest — see `caching.md`) and re-registers it into raw-core's process cache before any request whose sidecar names it: decode, live-session open and render, export. Hosted has only that copy; Self Hosted also uploads the same file to `POST /api/lens-profiles` on import and, when the browser copy is missing (a new browser, cleared site data), the worker asks the main thread to restore it from `GET /api/lens-profiles/:digest` first. A profile that no cache can supply is reported to the Lens Corrections panel as an explicit error; raw-core refuses that render rather than skipping the correction. The panel's import block (`lens-profile-import`) shows the resolver's camera/lens match, the families the calibration covers, the interpolated samples, reported approximations and unsupported records; **Use profile** writes `lcp1:<digest>` as one undoable edit, and approximations can only be applied after the separate acceptance checkbox, which writes `lcp1-ack:<digest>`. Each strength slider disables for a family the calibration does not cover. `maple-cli render --lens-profile <file.lcp> [--acknowledge-lens-approximation]` registers a document for one headless render and prints the resolver's evidence; `maple-cli inspect <file.lcp>` prints the parsed calibration inventory.

Windows keeps imported bytes under `%LOCALAPPDATA%\Maple\LensProfiles\<BLAKE3>.lcp` (`Services/LensProfileStore.cs`). The Lens group of the edit rail imports a `.lcp` through the five `maple_lens_profile_*` mirrors in `Native/RawFfi.LensProfile.cs`, shows the resolver's match, calibration samples, approximations and unsupported records, and lands **Use profile** as one undoable, decode-owned edit; the acknowledged spelling needs its own acceptance box and is only offered for an approximate match. `RenderEngine.Decode` re-registers the sidecar's selection from the store before every develop, and the queued export executor does the same from the item's frozen XMP through `maple_lens_profile_selected`, so a cold restart renders what the editor showed. The three strength rows are enabled per family from the resolved coverage.

Apple import UI, newer LCP model families and native-detail tiles for warped coordinates are outside the supported surface.

No third-party profile pack is redistributed. Import support does not establish a licensed distribution catalog or promote camera qualification tiers.

## References

The [Adobe Lens Profile Creator guide](https://www.adobe.com/special/photoshop/camera_raw/lensprofile_creator/lensprofile_creator_userguide.pdf) describes the calibration workflow. Mathematical conventions were checked against the independent implementations in [RawTherapee](https://github.com/RawTherapee/RawTherapee/blob/dev/rtengine/lcp.cc), [AliceVision](https://github.com/alicevision/AliceVision/tree/develop/src/aliceVision/lensCorrectionProfile) and the [Lensfun LCP converter](https://github.com/lensfun/lensfun/blob/master/apps/lensfun-convert-lcp). Tests use authored synthetic calibration coefficients; installed third-party profiles are read-only validation inputs and are not committed.
