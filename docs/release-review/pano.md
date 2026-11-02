# Panorama release review (v0.1.6)

Area 6. Reviewed against `origin/main` at `cf50ef2eca`, by reading the implementation on every listed platform. The Boundary Warp / Auto Crop series (#5570, #5608, #5609) was reviewed for regressions on real code paths.

## Verdicts

| ID  | Feature                                                        | Verdict                               | Findings                        |
| --- | -------------------------------------------------------------- | ------------------------------------- | ------------------------------- |
| P1  | Merge options (retention, local alignment, strategy), progress | works                                 | none                            |
| P2  | Edges: Boundary Warp + Auto Crop recorded in XMP               | works with P1                         | R2 (P1, #5628); R1, R3, R4 (P2) |
| P3  | Server provisioning, single-flight stitch                      | works                                 | none                            |
| P4  | Memory behaviour on iPad (epic #5450)                          | works (device behaviour not verified) | R5 (P2)                         |

No P0 findings.

## How P2 works end to end

1. The engine always writes the whole canvas and reports the largest fully covered rectangle (`maple-pano/src/composite/crop.rs`, `stitch/edges.rs`), with the written image's size beside it.
2. The server (`src/api/src/job-runner/handlers/pano-stitch.ts`) turns that rectangle into standard `crs:Crop*` fields (`pano/pano-crop-sidecar.ts`), stamps a `tEXt` chunk with the rectangle into the PNG so the cropped and uncropped stitches are different files by content (`pano/pano-png-crop-mark.ts`), writes the sidecar first with an exclusive create, then publishes the PNG. A failed publish removes only the sidecar it created.
3. Thumbnails and previews of bitmap originals apply the sidecar crop (`thumbs/render.ts`, `xmp/sidecar-crop.ts`), and the derivative cache is stale when the sidecar is newer than the cached file (`indexer/derivative-cache.ts`), so a sidecar that arrives after the PNG still refreshes the derivatives.
4. Apple does the same on device (`PanoAutoCropRecord.swift`): sidecar by non-overwriting create, then the PNG mark appended past the old `IEND` before the old `IEND` is overwritten, so the file never lacks a terminator. A cloud-frame stitch uploads the PNG then the sidecar (`DownloadedFramesStitcher.swift`).
5. Both merge previews show the crop of the whole-canvas preview (`PanoPreview.displayImage`, `pano-preview-crop.ts`).

Checks that held: the crop is refused when the rectangle does not fit the written image, which also covers an older binary that still trimmed pixels (a trimmed output can only contain the rectangle when it is the whole image); sidecar naming agrees across API (`xmpSidecarPath`) and Apple (`SidecarPath.sidecarURL`) for a PNG; a binary without the flags is refused with `pano_edges_unsupported` before a job is created; the running-stitch identity and output file name include both edge options.

## Findings

### R1 (P2, downgraded after tracing the scope): the crop sidecar is written after the stitch's own scope bracket closes

`RustPanoStitcher.swift:138` calls `recordAutoCrop` after `PanoFFICall.stitch` returns, outside the brackets in `PanoFFICall.withInputs` (`PanoFFICall.swift:215-219`) and `reserveOutputURL` (`RustPanoStitcher.swift:305-312`). The PNG and the sidecar land in the same folder, so the question is whether the folder is still writable then.

It is. The stitch's frames come from the open folder, and every path that opens a local folder in the browse view takes a bookmark-resolved scope and holds it for the session (`claimScope(for:)` in `AppShell+FolderActions.swift:41, 219, 292` and `AppShell+SourceRestore.swift:60`; "Hold scope for the whole session so detached render tasks work"). That grant covers the whole folder tree, including the `Panoramas/` folder beside the frames, so the sidecar write succeeds under the same conditions as the PNG write. When the frames' folder is not writable, the PNG and sidecar both go to the app container (`fallbackOutputDirectory`) or, for downloaded cloud frames, the download cache; both are always writable. So Auto Crop is not silently lost on sandboxed builds.

Remaining risk is only defensive: a future caller that stitches frames without the browse view holding their folder would write the PNG (inside the bracket) but fail the sidecar, and the failure is reported in the summary. Moving `recordAutoCrop` inside the reservation's bracket would remove that. Not verified on a device.

### R2 (P1): a refused sidecar upload leaves an uncropped duplicate on the server

`DownloadedFramesStitcher.swift`, `PanoServerUpload.add`: the PNG is uploaded first; if the following sidecar upload returns nil or throws, `add` throws `uploadRefused`. The PNG is already on the server and is not removed, and `stitch`'s catch deletes only the cached PNG. The user sees a failure; retrying stitches again under a new timestamped name, so the server holds an uncropped panorama from the first attempt plus the retry. Issue: #5628.

### R3 (P2): stale doc comment

`PanoStitching.swift:54` still says Auto Crop trims the output; since #5608 it records a crop and the PNG stays whole.

### R4 (P2): HEIC originals skip the sidecar crop

`thumbs/render.ts` returns early for `heic`/`heif` before `withSidecarCrop`, so a HEIC with a crop sidecar gets an uncropped thumbnail while the same crop on a JPEG or PNG is applied. Panoramas are PNG, so P2 itself is unaffected.

### R5 (P2): the story map's P4 reference is missing

`docs/strategy/milestones/pano-disk-backed-stitch.md` does not exist; the measured memory table lives in `docs/pano.md` § Memory and issue #5450 (closed).

## Not verified

- The Apple merge sheet and crop sidecar on a device or the simulator, and the live XMP-crop stitch through the server with a real `maple-cli`: no signed build or panorama fixtures were run.
- iOS and tvOS builds of the #5608 Apple change: this worktree's xcframework holds headers only (the libraries are generated, a release Rust build takes many minutes, and machine load was above 50), so nothing was compiled. By reading, the change uses only Foundation, CoreGraphics and `FileHandle`, `PanoEdgesReport.crop` replaced `autoCropped:` with no remaining callers of the old initializer label, and `PanoPreviewSection` calls the public `displayImage`. The `apple` job on `cf50ef2eca` was still in progress when read.
- iPad peak memory (P4): the figures in `docs/pano.md` are measured on a Mac; the on-device measurement is tracked by #1274.
- Windows has no Boundary Warp or Auto Crop surface, so P2 does not apply there.
