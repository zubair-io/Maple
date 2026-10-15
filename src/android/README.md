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
arm64 devices/emulators on Android 10 or later. The live editor requires a
compatible Vulkan GPU; initialization failures are reported in the app. No signing
credentials are committed.

```sh
./gradlew testDebugUnitTest lintDebug
./gradlew connectedDebugAndroidTest    # a running arm64 emulator/device
cargo test --manifest-path native/Cargo.toml --lib
```

Device tests open a committed RAW and a real raster, render with Vulkan,
change exposure/white balance, save and undo actual XMP files, recreate the
activity, export JPEG, and check that original bytes are unchanged. They also
cover supplementary Unicode and rejection of exports targeting an original.
Editor screenshots are written to `Download/MapleVerification` on the test device.
Host native tests check RAW and raster GPU output against the CPU reference
(maximum two byte levels), generated field access, and stable GPU pool
allocation. These are functional gates, not physical-device performance
qualification. The 16 ms / 100 MP release requirement remains unqualified.

## Shared design and persistence

`tools/codegen.sh` emits Kotlin tokens, XML colors, adjustment ranges/defaults,
XMP attribute names, and Rust scalar access from the canonical Rust schemas.
`bun src/android/scripts/sync-tool-glyphs.ts` copies the exact Apple/Web tool
paths into Android vectors. The launcher icon is the existing Maple artwork.

Original URIs are opened for reading only. Folder grants persist through the
Storage Access Framework. Folder edits use adjacent stem-swapped XMP files;
single-file/share intents use private sidecars with an explicit XMP export.
The XMP writer patches owned attributes in the original XML, retaining untouched
foreign bytes, and rejects external-write conflicts. SAF replacement writes a
temporary sibling before publishing and retains the previous sidecar until the
replacement succeeds. Provider rename semantics still need qualification on
real external/SMB document providers before a release.

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
incompatible numeric sidecar from the initial build after confirmation. AVIF
originals are converted through the OS decoder on Android 12+; older versions
do not advertise AVIF originals. HEIC/HEIF use the same staging path.

Tablet editing keeps its inspector and right tool rail; phone controls stay on
phones. Sources collapse into a drawer below 1000 dp, and preview actions wrap
as complete groups. The walkthrough test captures Library, Preview, Edit, and
Settings and checks that rating/Edit buttons remain inside the window without
overlap. The current tablet inspector/header and Settings composition still
differ from iPad’s floating glass surfaces; exact visual parity remains #4623.

Portrait canvases fit both viewport axes, including when error banners change
the available height. `PortraitCanvasTest` checks the real oriented RAW surface
bounds and captures its frames. `SafSidecarTest` grants access through the system
folder picker, creates and replaces adjacent XMP sidecars through the Android
external-storage provider, rejects stale baselines, and verifies the RAW bytes.
Provider renames use `DocumentsContract` and retain changed document IDs.
Failures identify the operation and exception and retain a stack trace in logcat.
