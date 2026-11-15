# Android build and distribution

Return to the [Android guide](README.md).

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
release. The release coordinator waits for Android alongside Mac and Windows and fails
promptly if the tag's Android distribution run fails or is cancelled.
Prerelease tags (for example `v1.2.3-rc.1`) skip Android signing and assets;
the coordinator requires only Mac and Windows for those releases.
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
scripts/with-cloud-api.sh ./gradlew connectedDebugAndroidTest   # running emulator/device; boots src/api
cargo test --manifest-path native/Cargo.toml --lib
```

Android CI uses the central conservative dependency selector, including shared
Rust/codegen, LUTs, fixtures and the Apple layout/font/icon inputs. The stable
**Android result** check rejects failed, cancelled or unexpectedly skipped work.
The complete device suite runs on API 36 with a 1280×800 dp tablet layout and
SwiftShader Vulkan, exercising the inspector/group resets and HEIF/AVIF cases.
Reports must contain at least 46 device and 28 JVM passes with no skips. The
22 native CPU/GPU/cache contract tests and the shared presentation/cache/scRGB tests run against
Mesa lavapipe, alongside APK assembly and lint. Reports, native output, logcat,
device configuration, screenshots and walkthrough captures are uploaded even
after a test failure. Only SDK setup
downloads have bounded retries; failing tests remain failures. The committed
48 MP HEIF fixture works on Linux; its regeneration script requires macOS.
Software rendering proves functional correctness, not physical GPU or frame-time
qualification, which remains under #4623.

The RAW+JPEG pair device round trip also requires the API's host native library:
`POST /api/assets/:id/rename` fails closed without its filename validator.
Android CI builds only the default host `raw-ffi` library (no GPU, panorama or
search features), reusing the existing Android Rust cache, and stages it into
`src/api/native/` before starting the fixture API. For local API setup, run
`src/api/scripts/build-raw-ffi.sh` from the repository root before the device command.
