# Maple Linux native host

The native Rust Linux port is tracked in [#4317](https://github.com/zubair-io/Maple/issues/4317).
This is an incremental implementation of that issue. Linux is not yet a release
surface: the editor is not feature-complete, and releases do not publish a Linux
build. The window uses egui/eframe
and wgpu directly, with Wayland and X11 support; it contains no WebView.
The application creates one raw-gpu context and gives its device, queue, adapter
and instance handles to eframe. The compute owner lives until the window exits;
RAW previews use the resident GPU path described below, with a CPU fallback.

```bash
cargo run --manifest-path src/linux/Cargo.toml -- /path/to/photos
cargo test --manifest-path src/linux/Cargo.toml
cargo clippy --manifest-path src/linux/Cargo.toml --all-targets --no-deps -- -D warnings
```

## Packages

Maple for Linux is packaged as a native `.deb` for Ubuntu 24.04 and as an AppImage.
Both are built by the Linux workflow on Ubuntu 24.04, so they need glibc 2.39
or newer, and each artifact has a `.sha256` file beside it. Flatpak is not built;
whether to publish one is an open product decision. Build them locally from a
release executable (the `.deb` needs `dpkg-dev`, the AppImage `squashfs-tools`
and the pinned [type2 runtime](https://github.com/AppImage/type2-runtime/releases/tag/20251108)):

```bash
cargo build --locked --release --manifest-path src/linux/Cargo.toml --bin maple-linux
python3 src/linux/packaging/package.py deb --output-dir dist
python3 src/linux/packaging/package.py appimage --runtime runtime-x86_64 --output-dir dist
```

Both packages install the same desktop integration: the
`app.justmaple.aperture` desktop entry, the canonical Maple icon and file
associations, so **Open With → Maple** works from a file manager. The associated
MIME types are the formats the library opens (`FILE_FORMATS` in
[`src/library.rs`](src/library.rs)). Five RAW types that shared-mime-info 2.4
does not define (SRW, 3FR, MEF, ERF, FFF) are declared by Maple's own MIME
package, `packaging/app.justmaple.aperture.xml`. The `desktop_integration`
test fails if the desktop entry or the MIME package drifts from that table,
and on Linux it also checks the system MIME database resolves every other type.
Opening a photo launches Maple on its folder with that photo selected.

- **`.deb`:** `sudo apt install ./maple_<version>_amd64.deb`. Installing a newer
  `.deb` the same way updates it; `sudo apt purge maple` removes it, and the
  system's desktop, MIME and icon caches refresh through dpkg triggers. The
  package depends on the Vulkan, Wayland, X11 and xkbcommon libraries Maple
  loads at runtime and recommends Mesa's Vulkan driver and
  `xdg-desktop-portal`.
- **AppImage:** run `packaging/install-maple-appimage.sh Maple-<version>-x86_64.AppImage`
  as your normal user. It extracts the AppImage into `~/.local/opt/maple-appimage`
  (no FUSE or root needed), installs the desktop entry, icon and MIME package
  under `$XDG_DATA_HOME`, and refreshes the user's caches. Running it again with
  a newer AppImage replaces the installation; `~/.local/opt/maple-appimage/install-maple-appimage.sh --uninstall`
  removes it, keeping any integration file changed since installation. The
  AppImage does not bundle graphics libraries; on Ubuntu 24.04 install
  `libvulkan1 mesa-vulkan-drivers libwayland-client0 libxkbcommon0 libxkbcommon-x11-0 libx11-6 libx11-xcb1 libxcb1 libxcursor1 libxi6 libxrandr2`.

Both formats use the same desktop file ID, so a per-user AppImage installation
takes precedence over an installed `.deb` in menus and file associations.
Photos and XMP sidecars are never touched by install, update or removal.
Cloud credentials require a working Secret Service provider such as GNOME Keyring.

## Diagnostics

`maple-linux --diagnose` (for the AppImage installation,
`~/.local/opt/maple-appimage/usr/bin/maple-linux --diagnose`) prints an
installation report without opening a window and without network access. It
reports the GPU adapter Maple would use and whether it is Vulkan, the display
session Maple will use and whether it is reachable (as in winit, a set
`WAYLAND_DISPLAY` means Wayland with no X11 fallback; remote X11 displays are
not probed), the runtime libraries that session loads, and whether the desktop
portal file chooser (or the zenity fallback) is available for the folder
picker. It never starts the portal; an installed but inactive portal is reported
as activatable. Environment values and photo paths are never printed. It exits 1
when it finds a problem that stops Maple from working, and 0 otherwise; software
rendering and the zenity fallback are reported as notes.

## Support matrix

[`packaging/support-matrix.json`](packaging/support-matrix.json) is the
published support claim. The table below is generated from it by
`python3 src/linux/packaging/support_matrix.py --write`, and the Linux workflow
fails if they disagree. Every `ci-smoke` row is turned into a CI container job,
so a row cannot claim automation that does not run. A `qualified` row requires
an evidence link, and none exists yet: physical Intel, AMD and NVIDIA GPUs under
GNOME and KDE, on Wayland and X11, still need qualification with visible photo
pixels in a screenshot.

<!-- support-matrix:start -->

| Distribution     | Package  | Session                      | GPU                      | Status   |
| ---------------- | -------- | ---------------------------- | ------------------------ | -------- |
| Ubuntu 24.04 LTS | .deb     | X11 (Xvfb, no desktop shell) | Mesa llvmpipe (software) | ci-smoke |
| Ubuntu 24.04 LTS | .deb     | Wayland (headless Weston)    | Mesa llvmpipe (software) | ci-smoke |
| Ubuntu 24.04 LTS | AppImage | X11 (Xvfb, no desktop shell) | Mesa llvmpipe (software) | ci-smoke |
| Ubuntu 24.04 LTS | AppImage | Wayland (headless Weston)    | Mesa llvmpipe (software) | ci-smoke |
| Ubuntu 24.04 LTS | .deb     | GNOME Wayland                | Intel, AMD, NVIDIA       | untested |
| Ubuntu 24.04 LTS | .deb     | GNOME X11                    | Intel, AMD, NVIDIA       | untested |
| Ubuntu 24.04 LTS | .deb     | KDE Plasma Wayland           | Intel, AMD, NVIDIA       | untested |
| Ubuntu 24.04 LTS | .deb     | KDE Plasma X11               | Intel, AMD, NVIDIA       | untested |
| Ubuntu 24.04 LTS | AppImage | GNOME Wayland                | Intel, AMD, NVIDIA       | untested |
| Ubuntu 24.04 LTS | AppImage | GNOME X11                    | Intel, AMD, NVIDIA       | untested |
| Ubuntu 24.04 LTS | AppImage | KDE Plasma Wayland           | Intel, AMD, NVIDIA       | untested |
| Ubuntu 24.04 LTS | AppImage | KDE Plasma X11               | Intel, AMD, NVIDIA       | untested |

- **qualified**: Installed, launched and showing photo pixels on physical hardware; evidence linked.
- **ci-smoke**: Installed, launched, opened through Open With, updated (.deb from an older version; AppImage through its installed installer) and removed in a clean container by every Linux CI run, on Mesa llvmpipe software Vulkan. Proves startup and a committed window buffer, not photo pixels, desktop shell behaviour or GPU performance.
- **untested**: Not verified; no support claim is made.

<!-- support-matrix:end -->

## Qualification and CI

The ordinary development-host executable requires glibc 2.43, verified from its
ELF requirements, and is not the Ubuntu 24.04 artifact. A separate fresh release
built inside Ubuntu Base 24.04.5 requires glibc 2.39 and passes X11 startup
inside that environment with Ubuntu's Mesa 25.2.8 / LLVM 20.1.2. All 93 native
tests passed on that baseline at that checkpoint: 41 editor/library tests and
52 integration tests, with none ignored. These cover sidecar persistence, cloud
journals, browsing, retained detail, export, resident GPU preview and
compositor pixels. The host build also passes GNOME Wayland startup. These
checks do not qualify older distributions, camera color, physical-GPU
performance, real-account cloud access or complete desktop accessibility.

The Linux workflow builds all targets, runs native tests serially with a required
Mesa Vulkan adapter, and builds the `.deb` and AppImage on Ubuntu 24.04. Its small
committed fixtures check integration and correctness; they do not qualify the
100MP hardware budget, a real cloud account or color-managed desktop output.
The workflow extracts the `.deb` outside the checkout and launches it under Xvfb,
requiring a live window with the launched PID, minimum dimensions and Maple's
desktop class, then under headless Weston with the AT-SPI check below.
Each package then runs `packaging/install_smoke.py` in a clean `ubuntu:24.04`
container: install, `--diagnose` (before and after the runtime libraries are
present), file associations, X11 and Wayland launch of the installed executable,
an **Open With** launch through the installed desktop entry, an update (the
`.deb` from a relabelled older version; the AppImage through its installed
installer), and removal of the application and its desktop integration,
including keeping a desktop entry the user edited.

Run the launch checks locally on X11 with `python3 src/linux/packaging/smoke.py /path/to/maple-linux`.
On a live Wayland desktop, run `python3 src/linux/packaging/wayland_smoke.py /path/to/maple-linux`.
For an isolated headless Wayland check, install Weston and run
`python3 src/linux/packaging/weston_smoke.py /path/to/maple-linux`.
The Wayland check unsets DISPLAY, follows Maple's own xdg toplevel/surface chain,
requires configuration acknowledgement and a committed non-null content buffer,
and verifies continued process lifetime. Mesa query callbacks cannot satisfy it.
It establishes startup and buffer submission, not captured-pixel correctness or
interactive accessibility. Both checks terminate only the process they launched.
A live Wayland AT-SPI check is available at
`tools/qualification/linux-native/accessibility_smoke.py` (requires dbus-python).
It verifies the named window/thumbnail, opening a real staged RAW, Exposure
editing and Undo through the desktop accessibility bus, real XMP autosave, and
unchanged originals. It temporarily enables accessibility, restores the prior
setting and closes only its own process. Full screen-reader and keyboard
interaction qualification remains open.

## Editor

The current shell opens local folders, discovers child folders, shows a
virtualized thumbnail grid, opens a fitted preview, navigates a filmstrip and
exposes the initial Light, Color, Effects and Detail sliders.

The desktop editor follows mapleeditor.com's floating top bar, right-hand tool
rail and single adjustment card. Selecting Light, Color, Effects, Detail or Film
changes the card; labels and values sit above each slider. Source navigation is
shown in Browse, leaving the editor canvas behind the floating controls. Library
connection actions live in the Library menu; Redo and Save XMP are under More.
Panel, canvas, hover, border and accent colors and button radii use shared tokens.
Auto is the default
profile; Neutral, ratings and pick/reject flags are selectable. Undo/redo follows
completed editing gestures. AUTO analyses the retained RAW on the worker and
commits the shared estimator's eight recommendations as one undoable edit, with
Auto WB provenance and auto-exposure Off. Edits or navigation invalidate late
results, and repeat analysis taps are disabled while it runs. Reset is one undoable
action: it restores known develop
values and as-shot WB, returns the profile to Auto, and retains crop, rotation,
ratings, flags and unknown XML. The same save/sync barrier publishes it.
Before / after renders the immutable
opening model with the live crop, caches one comparison frame, and exposes a
draggable divider plus a labeled split slider without editing XMP
or history. The top bar wraps to retain all controls at narrower widths. Ctrl+Z and
Ctrl+Shift+Z undo/redo document edits; focused text editors retain their own
undo keys. These shortcuts respect cloud-browse and transfer guards and do not interrupt
an active editing gesture. Plain F selects Fit and plain Z selects
100%; modified keys cannot accidentally change zoom.
Colour tokens and adjustment ranges/defaults/wire
keys come directly from raw-core.

RAW previews, including all eight EXIF orientations, use the shared resident GPU chain on the
worker. The resident upload is the capture decode (#5380): capture stages run
once in the fixed as-shot basis, and each tick renders it through the decode's
creative stage (white balance, camera profile, highlight recovery, exposure
gain), so a white-balance drag matches the refined render within one 8-bit step
without re-developing. The native UI registers the resulting texture on that same device,
without a CPU readback or pixel upload per tick. The shared presentation shader
writes encoded sRGB bytes into a UNORM attachment; egui samples a compatible
sRGB view over that same allocation, so its compositor receives linear samples.
Both UNORM and sRGB framebuffer paths preserve the encoded output within one
code value in the native compositor regression. Hot edits reuse the RAW prefix;
upstream edits replace it. New render requests share one cancellation signal
with CPU prefix development, RGBA packing and the active GPU chain, and
reject obsolete results. Imported crops, orthogonal rotations and off-axis straighten use the same core
rect rounding/angle snapping and resident presentation mapping. Combined perspective
and off-axis straighten retain the CPU path until the two required resampling
steps are implemented on the GPU (#4317). Failed GPU sessions use the
shared CPU renderer with a visible fallback reason; raster previews remain CPU.
Imported point curves that exceed the GPU's normalized knot capacity also use
the shared CPU renderer. Their complete control points remain in the XMP;
duplicate points that normalize within capacity stay eligible for GPU rendering.
Before/after comparison still uses the CPU reference.
RAW and raster canvases expose Fit / 100%, F / Z, anchored pinch/ctrl-wheel zoom and
clamped drag pan, with physical-pixel scale rather than preview-texture scale.
Raster source dimensions come from the shared header probe with EXIF orientation
applied, retained against the immutable opened snapshot. At 100% and above,
a 150ms debounce develops one visible native-resolution RAW or raster patch
with a 25% total pan margin capped at 512 source pixels. The worker retains
full-frame AE/Auto anchors and the embedded film binding through the shared
native-detail API for RAWs. One in-flight/one pending request, session and request
guards, and a shared base prevent stale patches from painting a new view.
Raster refinement retains one oriented colour-managed native source and uses
the shared non-RAW window chain without AgX. The patch limit includes its shared
spatial overlap; the source buffer has the shared decoder's separate limits. The patch
working-pixel cap is 8,388,608 including filter overlap. A new image or edit
invalidates the canvas overlay; Fit releases its UI textures. Fit, Browse and
comparison cancel requested detail work without closing the source. Queued
results lose their generation. Supported RAW base and tile demosaic, repair, capture
sharpening, sharpening and noise-reduction kernels also receive the request's
host cancellation flag. Auto fitting and remaining decode/display kernels can
still finish before cancellation is observed. Crops and rotations use native patches through the shared crop mapping. Off-axis
straighten retains the canonical bilinear sampler and its full-image coordinates;
filter, mask, grain and dither coordinates stay anchored to the full image.
RAW patches retain sensor neighbours for demosaicing, then impose DefaultCrop
before spatial color filters. Dehaze, global or per mask, tiles from the
frame's proxy haze maps (#3287). Perspective models use debounced
whole-image CPU refinement through
shared export-quality RAW demosaicing or the shared raster renderer. Explicit
zoom below 100% uses the same path at physical display resolution. Crop-relative
scale determines the pre-crop develop resolution, capped at 8,388,608 pixels;
larger sources therefore retain a scaled whole-frame refinement, rather than
full native corrected detail. The cap includes pixels hidden by the crop. Fit
releases refinement. Other native tile rejections attempt the bounded shared
whole-image renderer after releasing patch-only buffers. The fallback preserves
the originating request identity while painting the full canvas, labels the
result and reuses it on pans. Edits, Fit and source changes reset that decision.
If both paths reject the model, the base stays visible with an explicit error.
Native corrected windows and full memory/performance qualification remain #4317. Raster requests now observe cancellation between f32 chain stages and inside
supported sharpening and luminance/chroma NR kernels. Container decode and
remaining display/geometry kernels can finish before cancellation is observed.
CPU detail runs on an independent worker with one in-flight/one latest pending
request, sharing the existing RAW mosaic and source bytes through immutable Arc
ownership. It does not queue GPU previews or XMP saves behind a patch. Request
revision and source identity are checked before base work,
between base and tile work, and before UI pixel conversion/publication. Obsolete
base renders do not start a tile or retain new base pixels; cancellation after
a tile preserves valid cached anchors for a later request. Individual shared
kernels remain uninterruptible, so this does not establish cancellation latency.
Source identity invalidates its anchors even if a numeric session ID is reused.
Internal kernel cancellation, CPU contention/memory and physical-hardware
performance remain to be qualified.
A separate thumbnail worker has a two-request queue and a 128-entry session
texture cache; current-session XMP saves and folder reloads invalidate it.
The active preview is capped at 1600px, thumbnails at 256px. Slider ticks retain
Auto-profile curve/LUT/noise buffers and a cached source-byte AE decision; RAW-byte
probes and Auto fitting run at preparation rather than every hot edit. Eight scene/display
curve and local/mask buffers retain storage across unchanged-size edits. Prefix
change detection uses a borrowed comparison with zero allocations in its targeted
1,000-comparison qualification. Remaining
downstream rendering/model-snapshot allocations, combined geometry sampling, Auto-fit cancellation, refine/zoom and
complete parity/performance/release qualification remain in #4317. The shared
host binding is `raw-core::gpu_host`, also used by the browser.
The shared single-submit GPU path now constructs each typed pass on the stack
and encodes it immediately from the same gates used by the boxed reference and
dehaze fallback. NR passes borrow retained camera noise coefficients. A targeted
host allocation test covers active tone/exposure, colour, spatial, dehaze and NR
controls with a populated noise profile and all eight non-identity point curves:
pass construction allocates nothing
for that set, while the boxed counterpart is observed allocating. Fixed-stride
scene/display curve serialization also uses stack arrays rather than temporary
slot/flattened vectors. Curve knot/tangent preparation, per-stage command
encoding, model snapshots and the fallback
remain outside that zero-allocation claim; full-loop qualification is required.

Temperature/Tint display the shared core's camera-specific effective pair. A WB
edit converts both components to the current scale and preserves the other
component; opening or editing exposure retains imported WB provenance. The complete
shared film catalog is embedded in the binary and decoded lazily with retained
immutable storage. The Film inspector offers all catalog looks, None and a
strength slider, with undo/redo and non-destructive XMP persistence. Look and
strength changes retain the uploaded RAW prefix and borrow the decoded lattice.
Selected and imported film looks reach CPU/GPU previews, comparison and
RAW/raster export through the existing core film entry points. Unknown IDs produce
an explicit error; they never fall back to an unrequested ungraded render.

Serialized saves run outside the UI thread after a 750ms idle interval, before
navigation and before closing. A failed save keeps the edited document open.
Retry Save XMP or explicitly reload XMP to discard those edits and read external
changes. `SidecarStore` rejects malformed XML, sidecar symlinks and detected
external changes. Saves sync a temporary file, retain existing permissions,
rename in the same folder and sync the directory. Optimistic comparison does
not provide a filesystem-wide lock against uncooperative external writers
racing the rename. Originals are never written.

The writer owns the controls exposed by this shell, Profile, culling and required
bookkeeping. Other attributes and nested XML are retained from the imported
source, including edits from tools this initial shell does not expose. New
documents use the canonical envelope and number format. Imported outer layout is
retained to preserve foreign content; namespace aliases are resolved in a
temporary reader copy. No schema version or shared processing stage changes.

Tests use actual files and the committed synthetic grey DNG. They verify
unchanged originals, save/reopen rendered-pixel identity, metadata preservation,
namespace handling, canonical defaults, worker conflict detection and native UI
save/navigation ordering. These are not substitutes for the RAW/ACR corpus or
the 100MP hardware performance gate.

For a repeatable real-window smoke test on a Wayland/X11 desktop:

```bash
cargo run --manifest-path src/linux/Cargo.toml --example native-smoke -- \
  src/apple/MapleUITests/Fixtures/synthetic /tmp/maple-native-window.ppm
```

This renders the real application, captures its native viewport after three
seconds, then closes. A screenshot verifies window presentation only. The
available development VM uses llvmpipe; hardware latency qualification requires
a physical GPU and the reference RAW corpus.

Export creates full-resolution sRGB JPEG (quality 95) or PNG through the shared
core; RAW sources additionally support 16-bit TIFF by choosing a `.tiff` filename.
The picker captures the selected photograph and adjustment snapshot. Processing
runs on the I/O worker. Publication uses a synced temporary file and an atomic
create-only operation; existing files and symlink destinations are refused.

The shared raster develop entry accepts opaque JPEG/TIFF/PNG/WebP inputs.
Tagged RGB input uses the shared ICC transform; untagged input uses sRGB.
PNG 16-bit input retains its precision through the float develop path.
Transparency is rejected explicitly rather than silently flattened. Raster
previews and JPEG/PNG exports use the same shared edit pipeline; RAW-only
adjustments still produce a clear unsupported-control error on raster sources.

Cloud browsing is connected through the native **Connect to Maple** dialog.
Enter the server URL, complete the existing Maple PKCE ceremony in your browser,
then choose a library. The verifier stays in the process; only the S256 challenge
and opaque state appear in the browser URL. The worker polls the existing claim
endpoint, validates the returned state and stores the device refresh token in
Linux Secret Service through keyring. A working desktop Secret Service is
required; credential failures are surfaced rather than falling back to plaintext.
HTTPS is required for public servers; localhost/private LAN IP HTTP is allowed.
Reverse-proxy path prefixes are retained. HTTP redirects are refused.

The client restores/rotates saved credentials and retries one bearer request
after a 401. Transient refresh errors retain the credential; only origin 400/401
rejection deletes it. Cloud browsing uses unified address routes, 500-entry
cursor pages, a bounded media queue and a 128-entry session thumbnail cache.
AVIF derivatives decode through raw-core's patched native decoder. Full-image
previews, retry, parent/child navigation and explicit credential deletion are
wired. “Edit original” downloads a photograph into the native editor, with the same
controls, export and cloud filmstrip. Navigation and closing wait for a confirmed
XMP save. Conflicts retain local edits; explicit Reload XMP adopts the server version.

The cloud tests exercise actual HTTP requests against a loopback protocol
fixture, including PKCE state validation, refresh rotation/rejection/retry,
address escaping, reverse-proxy prefixes and real AVIF encode/decode. They do
not prove production server connectivity, browser authentication or native
Secret Service persistence; those require a real server/account and desktop.

The transfer layer now downloads a real original into a private owned directory,
validates its size, parses the versioned remote XMP and saves through exact-content
HTTP preconditions. It refuses servers lacking the precondition capability and
retains local document state when the server rejects a stale version. Pending edits and their remote content baseline persist in a private journal
under the desktop data directory (`maple/cloud-edits`). Journals exclude concurrent
editors and resume unsynced edits after restart: on the next connection every pending
journal for that server is checked against live original metadata before synchronization.
A failed resume preserves the journal and reports it without blocking other photos.
Opening its photograph exposes Save XMP and Reload XMP recovery immediately; active
pending edits still prevent navigation until synchronized or explicitly reloaded.
Changed remote originals are refused while their pending edits remain on disk.
Credentials stay in Secret Service.

For cross-process qualification against the actual Maple API XMP routes:

```bash
cargo run --manifest-path src/linux/Cargo.toml --example cloud-transaction -- /path/to/bun
```

The example starts a disposable Elysia fixture using the real route implementation
and committed synthetic RAW, downloads it, conditionally creates an XMP, simulates
an external edit and proves conflict rejection, size-mismatch rejection and original
immutability, durable resume and explicit conflict reload. Browser auth and Secret Service use explicit test fixtures in this
example; the sidecar layer uses real files and real API writes throughout.

The preview worker keeps one pending slider snapshot rather than queuing every
tick. A newer tick replaces that snapshot; results superseded during a CPU
develop are discarded. Save/export/file commands preserve their order and exact
document snapshots. A real-RAW 2,000-tick burst test verifies the last preview,
saved/reopened pixels and original immutability. The current CPU renderer still
cannot interrupt an individual stage. The resident GPU path has separate
cancellation checks; no slider latency qualification is claimed by this scheduling test.
