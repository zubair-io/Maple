# Maple for Android

Native Kotlin / Jetpack Compose phone and tablet application over the shared
`raw-core` / `raw-gpu` pipeline. Development is tracked by
[#4623](https://github.com/zubair-io/Maple/issues/4623).

This is an **incremental port, not full iOS feature parity**. The implemented
surface opens local photos and writable document-tree folders, browses nested
folders, previews images, rates/picks, develops the shared scalar adjustments,
selects Auto/Neutral, supports undo/redo, persists XMP, and exports JPEG/XMP.
Phone navigation is Library / Search / Settings with a sources drawer. Tablets
use a sources column, image area, and controls or Info inspector, with a vertical
filmstrip. Search currently searches names in the open folder. Maple Cloud/self-hosted
connections support the iPad server-domain sign-in flow, registered libraries,
nested folders, remote previews, and editing with conditional XMP saves. Device-library
backup, server search/map/admin, and the remaining specialized editor surfaces
are not implemented; the full port issue remains open. Android delegates
SMB access to OS document providers through the existing folder picker; a direct
SMB client and credential manager are outside the Android scope.

## Build

Requires JDK 21, Rust stable, Android SDK 36, Build Tools 36.0.0, NDK
28.2.13676358, and CMake 3.22.1. Set `ANDROID_HOME` to the SDK directory. Install
the Rust target once:

```sh
rustup target add aarch64-linux-android
cd src/android
./gradlew assembleDebug
```

Gradle builds the release Rust static library before linking the JNI library.
The APK is `app/build/outputs/apk/debug/app-debug.apk`. Current packaging targets
arm64 devices/emulators on Android 10 or later. CI additionally builds x86_64
with `-PmapleAbis=arm64-v8a,x86_64` and installs that native ABI on an Ubuntu
KVM emulator; it does not depend on ARM translation. Install the
`x86_64-linux-android` Rust target when building that ABI. The live editor requires a
compatible Vulkan GPU; initialization failures are reported in the app. No signing
credentials are committed.

## Signing and distribution

Android reads the canonical product version from `src/maple/package.json`.
Release packaging requires the upload keystore and an explicit positive
`-PmapleVersionCode`; an unsigned release fails. `android-distribution.yml`
uses its own monotonically increasing workflow run number plus one for every
signed build, across main, tags and manual runs. Code 1 belongs to the initial
Console upload; CI starts at code 2. Keep this workflow/counter when
changing delivery, so Play version codes never restart.
Distribution uses GitHub's [`queue: max`](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)
to keep pending builds instead of cancelling a pending release when another
main build arrives. Publication remains serialized.

After the **Android** push workflow succeeds on main, distribution builds
the exact tested SHA, verifies signatures, runs release lint, and uploads its
AAB to **internal testing**. A delayed run checks current main before publishing;
the publisher also refuses to replace a higher internal version code. Rerunning
a failed publication reuses the signed artifact and verifies Google's returned
version code and SHA-256. Permission, upload, review and commit errors fail the
job. Existing Play reviews are never automatically cancelled.

Tags `v<product-version>` build signed APK/AAB files and attach them, their
SHA-256 checksums and the public upload certificate to the coordinated GitHub
release. The release coordinator waits for Android alongside Mac and Windows.
Tags do not promote a public Play production release. Manual dispatch on `main` creates
verified signed artifacts only, including the first bundle needed to create
the initial Play release in Console.

The GitHub `android-signing` environment permits only the `main` branch and
`v*` tags through deployment branch/tag policies. Its environment secrets are
`ANDROID_UPLOAD_KEYSTORE_BASE64`,
`ANDROID_UPLOAD_STORE_PASSWORD`, `ANDROID_UPLOAD_KEY_ALIAS` and
`ANDROID_UPLOAD_KEY_PASSWORD`. `scripts/package-release.sh` materializes the
key in a private temporary directory and removes it on exit. Keep these secrets
out of repository-wide secrets so feature-branch workflows cannot read them.
The active [Signed release tags ruleset](https://github.com/zubair-io/Maple/rules/25216697)
restricts creation, updates and deletion of `v*` tags to repository owner
`zubair-io`; the existing version-sync automation uses that owner's token.
The public
certificate is `signing/maple-upload.pem` (RSA 4096, expires March 2054,
SHA-256 `1C:B8:8A:BE:91:9C:0E:2D:92:6B:58:8C:2C:08:16:D6:28:60:DE:E2:39:38:C1:95:D6:E4:79:90:78:04:3D:F7`).
Keep the encrypted original and its password in the owner's secure backup;
neither belongs in git. Google Play holds its separate app-signing key. Direct
APK installs use the upload certificate, so they cannot update a Play-installed
copy signed by Google's different app key (or an existing debug install).

Play API authentication uses Google Workload Identity Federation, with no
exported service-account JSON key. Repository variables
`GOOGLE_PLAY_IDENTITY_PROVIDER` (the full provider resource name) and
`GOOGLE_PLAY_SERVICE_ACCOUNT` select the configured identity. The provider
must accept GitHub's issuer `https://token.actions.githubusercontent.com`, map
`google.subject=assertion.sub`, and restrict its attribute condition to:

```text
assertion.repository_id == '1219479764' &&
assertion.repository_owner_id == '140374' &&
assertion.workflow_ref == 'zubair-io/Maple/.github/workflows/android-distribution.yml@refs/heads/main' &&
assertion.event_name == 'workflow_run' && assertion.ref == 'refs/heads/main'
```

Grant that federated subject `roles/iam.workloadIdentityUser` on the dedicated
publisher service account. Enable the Android Publisher API in its Cloud
project. In Play Console grant that service account **Maple only**, with view
app information and release-to-testing permissions; production, financial,
user-management and account-wide admin access are unnecessary. Authentication
runs after the build with an `androidpublisher` scoped, short-lived token.
The initial Play listing/release and this Cloud/Play access setup are tracked
in [#4651](https://github.com/zubair-io/Maple/issues/4651).

The configured Cloud project is `just-maple` (`82234956625`), with provider
`projects/82234956625/locations/global/workloadIdentityPools/maple-play-ci/providers/maple-main`
and publisher `maple-play-publisher@just-maple.iam.gserviceaccount.com`. The
service-account binding accepts subject
`repo:zubair-io/Maple:ref:refs/heads/main`; the provider condition above further
restricts the workflow and event. Its Play grant is limited to Maple app
information, inherited app-quality viewing and release-to-testing access.
The first signed bundle, version `0.1.5` / code `1`, was published through
Console to bootstrap the app. The owner is on the selected **Maple Internal**
tester list; join at [the internal test link](https://play.google.com/apps/internaltest/4701614480911697756)
using `zubair@justmaple.app`. Play shows its temporary package-based name until
store setup and review are complete.

```sh
./gradlew testDebugUnitTest lintDebug
./gradlew connectedDebugAndroidTest    # a running arm64 emulator/device
cargo test --manifest-path native/Cargo.toml --lib
```

Android CI uses the central conservative dependency selector, including shared
Rust/codegen, LUTs, fixtures and the Apple layout/font/icon inputs. The stable
**Android result** check rejects failed, cancelled or unexpectedly skipped work.
The complete device suite runs on API 36 with a 1280×800 dp tablet layout and
SwiftShader Vulkan, exercising the inspector/group resets and HEIF/AVIF cases.
Reports must contain at least 37 device and 26 JVM passes with no skips. The
19 native CPU/GPU tests and the shared presentation/cache/scRGB tests run against
Mesa lavapipe, alongside APK assembly and lint. Reports, native output, logcat,
device configuration, screenshots and walkthrough captures are uploaded even
after a test failure. Only SDK setup
downloads have bounded retries; failing tests remain failures. The committed
48 MP HEIF fixture works on Linux; its regeneration script requires macOS.
Software rendering proves functional correctness, not physical GPU or frame-time
qualification, which remains under #4623.

Device tests open a committed RAW and a real raster, render with Vulkan,
change exposure/white balance, save and undo actual XMP files, recreate the
activity, export JPEG, and check that original bytes are unchanged. They also
cover supplementary Unicode and rejection of exports targeting an original,
including MediaStore/DocumentsUI aliases in both directions. Exports open a
non-truncating read/write descriptor, compare device/inode identity, and only then
truncate/write through that same descriptor. Providers without regular seekable
descriptors are rejected before writing; JPEG rendering finishes before the
export destination is touched. See Android’s [file-descriptor API](<https://developer.android.com/reference/android/content/ContentResolver#openFileDescriptor(android.net.Uri,%20java.lang.String)>).
Editor screenshots are written to `Download/MapleVerification` on the test device.
Device color tests compare every OS-decoded channel and its source color profile to the staged float TIFF,
including wide-gamut and 10-bit AVIF fixtures. Cloud persistence tests retain a
late edit through model teardown and round-trip a 17 MiB opaque sidecar.
Host native tests check RAW and raster GPU output against the CPU reference
(maximum two byte levels), generated field access, and stable GPU pool
allocation. The serial renderer worker retains one GPU device and its shader
caches across photo sessions, then closes photo resources and the device before
its thread shuts down. Native tests render a replacement image through that
same warm context and compare it with the CPU reference. These are functional
gates, not physical-device performance
qualification. The 16 ms / 100 MP release requirement remains unqualified.

## Shared design and persistence

`tools/codegen.sh` emits Kotlin tokens, XML colors, adjustment ranges/defaults,
XMP attribute names, and Rust scalar access from the canonical Rust schemas.
`bun src/android/scripts/sync-tool-glyphs.ts` copies the exact Apple/Web tool
paths into Android vectors. The launcher icon is the existing Maple artwork.

Original URIs are opened for reading only. Folder grants persist through the
Storage Access Framework. Folder edits use adjacent stem-swapped XMP files;
single-file/share intents use private sidecars with an explicit XMP export.
Single-file opens stream a fresh read into an atomic cache snapshot and SHA-256
digest before choosing pixels or edits, with import progress and cancellation checks.
Private sidecars include that digest, the source URI, size and modification time in
their identity, so a reused URI with different bytes gets separate edits even when
provider metadata is absent or unchanged. Rendering uses the hashed snapshot; if
it is evicted, the user must reopen instead of reading new bytes under an old identity.
Earlier URI/metadata-only private sidecars are retained and are not automatically assigned
to a photo whose identity cannot be verified. Folder-adjacent sidecars are unaffected.
The XMP writer patches owned attributes in the original XML, retaining untouched
foreign bytes, resolves RDF and owned attributes by namespace, and rejects
external-write conflicts. Legacy Maple namespace aliases are read and owned edits
remove their older spelling. If a canonical prefix belongs to a foreign
namespace, writes reuse an owned alias or declare a nonconflicting prefix without
rebinding the foreign XML. A shared-core namespace-aware event reader feeds every
native preview/editor/validation/export entry without a DOM or full-document
normalization copy; persisted XML remains lexical. Opaque subtrees are validated
as a borrowed stream and never retained by the adjustment reader.
Loading validates the immutable source and its RDF description without
serializing a throwaway document; serialization occurs only for a real consumer.
Each immutable source is parsed once, and scalar/metadata revisions share its
namespace-resolved attributes, so UI lookups do not scan opaque XML on slider ticks.
Unstamped imported temperature/tint keep their foreign or legacy Maple scale
when unrelated edits add Maple metadata, so rating or picking cannot change color.
Local sidecar reads detect BOM/XML-declared encodings, retain the source byte
order on save/recovery/XMP export, and reject malformed or unrepresentable
metadata before publication. The byte order is made explicit in the XML
declaration; unknown child text stays verbatim. Cloud responses are decoded
by their XML encoding and cloud writes follow the server’s UTF-8 text API.
Existing servers still require stored sidecars to be UTF-8. See the
[XML encoding detection rules](https://www.w3.org/TR/xml/#sec-guessing).
Cloud folder browsing follows bounded cursor pages, including empty media pages,
filters before retaining entries, deduplicates returned addresses and rejects
repeated cursors.
Cloud derivatives use persistent identity/edge/pipeline indexes and conditional
ETag validation; unchanged loads reuse their image body, and missing cache files
are rebuilt. Back clears a pending open’s loading state before returning to Browse.
The stop-time flush remains active through ViewModel teardown, including waits
behind an earlier save. Cloud XMP responses use the server’s 128 MiB body limit;
other JSON responses remain bounded at 16 MiB. UTF-8 validation uses a fixed-size
scratch buffer. Incoming Open/Share navigation changes only after pending edits
save successfully; a conflict retains the current folder, filmstrip and document.
HTTP responses transfer their bounded byte buffer without cloning it; XML, JSON,
hashing and derivative publication consume only its received range. Oversized
declared lengths fail before body allocation.
Requests count UTF-8 bytes before streaming through a bounded character encoder,
including supplementary characters split across encoder buffers.

RAW white-balance resets omit the authored pair and provenance and restore the
camera's as-shot controls from the shared core, as one Undo entry. Group resets
also clear their Black & white or Film selector in that same transaction. Thumbnail
identity hashes stream their prefix and XMP through bounded UTF-8 buffers.
HEIF/AVIF live previews set the requested edge inside the OS decoder before
bitmap allocation, and cache separate source-gamut TIFFs by edge. The compressed
source is reused, and full-resolution staging is deferred to export. Local
thumbnail version 4 invalidates previews from the earlier full-image path.
Cache readers open a descriptor atomically with publication/eviction and keep it
through bitmap decoding, including conditional revalidation and cancellation.
Eviction can unlink a path without invalidating an active reader; network and
decoding work remain concurrent. Original-cache leases also span library instances.

Slider ticks replay the resident GPU image (up to 2048 pixels) without CPU
preparation. HSL, B&W, defringe, parametric splits and present geometry are GPU
owned, so their controls do not re-develop the sensor or apply a stage twice.
Capture sharpening immediately uses the existing GPU pass on a separate,
prewarmed 512-pixel zero-capture upload. Amount/sigma changes update pooled
uniforms and a fixed-capacity kernel buffer. This small preview is an
interactive approximation; the final preview uses capture-before-AE CPU order
and disables GPU capture, so a stage is never applied twice. Clearing capture
returns to the untouched fast upload immediately.
CPU prefix changes such as capture sharpening and lens corrections refine after
150 ms of quiet on a separate serial CPU worker. Preparation holds immutable
source Arcs, shares the host cancellation signal with the core, and transfers
only a completed current result back to the GPU owner. New edits, navigation
and teardown cancel refinement; source identity, model and revision guards
reject stale uploads. Live GPU requests keep their own cancellation signal,
so a new frame cannot clear an older CPU job's cancellation. Physical frame-time
qualification remains tracked under #4623.

As documented for the shared editor in `docs/pipeline.md`, transparency and CMYK
inputs are rejected before output creation; the editor does not flatten them.

The live canvas negotiates managed wide-color display support and Vulkan's float
surface capability. On that path the shared chain targets Display P3 and the
present pass transports it as unclipped linear scRGB in an RGBA16F surface with a
matching Android dataspace; generated core matrices and numeric CPU/GPU gates
cover the conversion. Other surfaces use sRGB. Physical display and performance
qualification remain under #4623.
Failed sidecar loads block metadata, editing and export
until a successful reload confirms that photo’s save baseline. SAF replacement writes a
temporary sibling before publishing and retains the previous sidecar until the
replacement succeeds. Provider rename semantics still need qualification on
real external/SMB document providers before a release.
Canonical folder sidecars match names case-insensitively, retaining an existing
file's casing through save and recovery. Ambiguous duplicate names stop edits.

Native editor calls and surface ownership are serialized on one worker.
`ANativeWindow` is retained until its wgpu surface is dropped. Only one decoded
image is resident. Slider draws coalesce, and undo commits at gesture boundaries.
Saves debounce for 750 ms and flush on navigation/backgrounding.

App-private caches are reconstructible and bounded: staged originals use
512 MiB plus the currently leased file; thumbnails/previews share 64 MiB. A
staging lease prevents eviction during decode/export. Derived keys include
pipeline output version, original URI, size, mtime, requested edge, and the complete current sidecar.
An unedited thumbnail extracts the embedded JPEG, with real develop as fallback;
an edited thumbnail/preview uses the canonical develop chain. No derivative is
written into the user's photo folder.

## Cloud connections

Use **Add Maple Cloud server** in Sources or Settings → Cloud for hosted and
self-hosted servers; they use the same connection protocol. Maple opens the
server’s HTTPS domain in the system browser for passkey sign-in. Android also
polls the PKCE claim endpoint so an existing browser session can finish sign-in
when the browser blocks an automatic custom-scheme callback. A one-time
PKCE code returns through `maple-app://auth-success`; tokens never appear in
callback URLs. Access/refresh tokens and pending verifier/state are encrypted
with an Android Keystore key, and expired access tokens refresh once before
retrying. Loopback HTTP is supported for development. Disconnect revokes the
server session when reachable and always removes this device’s credentials.

Library reads use the unified folder/image/thumb/preview routes. Server
derivatives are freshness-checked by the server; Android 10/11 use the shared
original-based thumbnail path because the OS has no AVIF decoder. XMP writes
require `content-etag-v1`, a strong `If-Match` or create-only `If-None-Match: *`.
A conflict retains unsaved edits; **Reload saved edits** asks before discarding
them. Older servers without conditional saves must be upgraded before editing.
The cloud device test exercises real HTTP, Keystore persistence, PKCE/state
checks, cancellation during redemption, refresh/disconnect ordering, nested Unicode
paths, real XMP saves/conflicts, and original-byte
preservation against a temporary fixture server. Live account/passkey-provider
and physical-device qualification remains outstanding.

Numeric raster availability is generated from the Rust raster validator and
cross-checked by the native test. RAW-only sliders are hidden for raster inputs
and rejected by the native boundary. **Reset RAW-only sliders** recovers an
incompatible numeric sidecar from the initial build after confirmation, only
when the shared Rust validator accepts the full candidate. Sidecars with
unsupported structured or enum edits keep their original XMP and error; numeric
recovery is unavailable rather than saving a partial reset. AVIF
originals are converted through the OS decoder on Android 12+; older versions
do not advertise AVIF originals. HEIC/HEIF use the same staging path: the OS
retains the source gamut and native RGBA8, packed 10-bit or F16 output. JNI
transports those channels into a float32 TIFF with a matching input ICC profile,
without a forced sRGB or 8-bit conversion. Profile colorants and parametric
transfer curves come from the [OS RGB color-space metadata](https://developer.android.com/reference/android/graphics/ColorSpace.Rgb). The shared core converts it to scene-linear Rec.2020. Non-parametric HDR transfer
curves fail explicitly rather than being reinterpreted as SDR.
Older PNG stages are excluded by the versioned stage identity.

Tablet editing now uses a floating capsule header, centered collapsible filmstrip,
a translucent trailing inspector and tool dock over a bounded full canvas. Phone
controls use the compact bottom surface; the same editor state survives panel
changes and activity recreation. The header RGB histogram samples the presented
surface after 300 ms idle through Android PixelCopy, with one reusable 256×128
bitmap, outside the Rust render loop. See [PixelCopy](https://developer.android.com/reference/android/view/PixelCopy).
The inspector can be hidden, and resetting its current slider group creates one
undo step. Auto/Neutral profiles remain available under More photo actions.

Library uses floating source/action controls and a page title. Folder browsing
matches Maple’s 180×64 tiles (4 dp radius, Maple’s rounded primary folder glyph, 14 dp
side padding and single-line Lato labels) in a separate wrapping block above
the photo grid. Tile sizes stay fixed when photo thumbnail sizes change. The
Folders navigation section uses lazy nested rows with 16 dp indentation,
independent disclosure controls, active-row fill/2 dp primary border, and
auto-reveals the selected folder after grid navigation. Parent navigation uses
actual provider-listing ancestry, including providers with opaque document IDs.
Hidden dot folders stay out of Browse and navigation. Local folders and cloud
libraries share the tree; failed listings expose retry. The canonical rounded
folder/chevron paths are exported from MapleUI’s bundled font by
`scripts/sync-navigation-glyphs.py` (Python fontTools). Lato and icon licenses
are bundled in the APK.

Settings is a
centered grouped sheet with working General, Cloud, Sources and About panes.
The walkthrough captures Library, Preview, Edit, Settings and Cloud Settings;
it verifies capsule/inspector separation, panel collapse/reopen, real histogram
readiness, ratings (including authored decimals), reset/undo and nested navigation.
`FolderNavigationTest` opens a real OS document folder, creates nested/hidden
folders and long names, and verifies tile layout, selection/reveal, independent
disclosure, parent/back navigation and original bytes.
Advanced editor tools, remaining Settings destinations, canvas gestures and exact
platform glass treatment remain tracked in #4623.

Portrait canvases fit both viewport axes, including when error banners change
the available height. `PortraitCanvasTest` checks the real oriented RAW surface
bounds and captures its frames. `SafSidecarTest` grants access through the system
folder picker, creates/replaces adjacent XMP, replays interruption before/after
publication through a fresh library instance, rejects stale baselines and verifies
original RAW bytes. A synced app-private transaction journal records the staged,
backup and canonical names before any replacement rename. Recovery restores old
edits or adopts the completed publication, preserving provider-assigned names and
changed document IDs. Providers must support create, rename and delete.
Failures identify the operation and exception and retain a stack trace in logcat.

A single batched folder query populates local names/URIs/metadata. Thumbnail
sidecar lookups reuse that snapshot; open/save/list/recovery refresh or invalidate
it, while XMP contents are always read fresh. Metadata-only RAW sidecars keep the
embedded-preview fast path. The local thumbnail cache key includes Android
thumbnail version 2 to retire earlier unnecessarily developed culling previews.
Incoming Open/Share MIME filters advertise supported formats only, with an
Android 12+ AVIF alias; file-picker inputs are validated before opening.
