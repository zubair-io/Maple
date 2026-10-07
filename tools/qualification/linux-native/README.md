# Linux toolkit compatibility probe

Repeatable headless qualification for [#4317](https://github.com/zubair-io/Maple/issues/4317).
This is a diagnostic tool, not the Linux product shell.

```bash
cargo run --manifest-path tools/qualification/linux-native/Cargo.toml
```

The probe constructs the actual egui renderer on raw-gpu's existing device. Its
pinned egui-wgpu 0.30 dependency shares wgpu 23 with Maple, requiring no shared
renderer upgrade. It uploads a deterministic scene-linear 16×16 RGBA calibration
buffer with negative values and highlights above one, runs Maple's exposure
shader at −4, 0, +1 and +4 EV, and compares every channel against raw-gpu's CPU
exposure reference. Readback is deliberate diagnostic work, not an editor path.
A missing adapter, incompatible pipeline or parity error fails the command.

A pass establishes device/type compatibility and exposure correctness only. It
does not establish native window presentation, full RAW-chain parity,
accessibility, color-managed presentation, or slider performance. CPU adapters
are reported explicitly; their results cannot qualify the 16ms hardware budget.

The first local run used Vulkan llvmpipe on Ubuntu with Mesa 26.0.8. Reference
RAW fixtures were absent. A physical GPU and the shared RAW/ACR corpus are
required before performance and full-chain acceptance can be recorded.

A second diagnostic runs the actual native Maple shell on raw-gpu's shared
instance/adapter/device/queue handles and captures its presented window:

```bash
cargo run --manifest-path tools/qualification/linux-native/Cargo.toml --example shared-window -- /path/to/photos /tmp/maple-shared-window.ppm
```

It checks adapter, device and queue pointer identity against egui's actual render
state, repeats exposure correctness on that device, then saves a window capture
and closes. The Linux product's resident photograph GPU path is still tracked
in #4317; this diagnostic does not claim that integration or its latency.

The local shared-device run passed and captured a real 1406×821 native window.
The complete raw-gpu library suite passed serially: 258 passed, 4 ignored timing
benchmarks and none failed. The 16 live-session tests include warm buffer reuse
and exact repeated-frame output. The GPU FFI compile gate also passed.

Run GPU tests serially, as CI already requires under #2336. Parallel execution
crashed with SIGSEGV on this software adapter for both the changed context and
an isolated copy of the unchanged HEAD context; it is not accepted as a green
run. Serial qualification preserves the test assertions. The software-adapter
results still do not qualify reference-hardware timing or the absent RAW/ACR
corpus. See `.github/workflows/raw-pipeline.yml` for the documented concurrency
restriction.

The packaged application also has a real AT-SPI integration check on a live
Wayland desktop (requires `dbus-python`, available as `python3-dbus` on Ubuntu):

```bash
python3 tools/qualification/linux-native/accessibility_smoke.py /path/to/unpacked/bin/maple-linux
```

It temporarily enables desktop accessibility and restores the previous value,
launches only its own Maple process with X11 disabled, and uses the process PID
to identify its accessibility tree. A private copy of the committed synthetic
RAW is opened by its named thumbnail; the Exposure slider is set through AT-SPI,
its XMP autosave is checked, then Undo must persist the default again. Original
bytes must remain unchanged. Replaced loading nodes trigger a fresh tree read;
missing controls, unsupported actions and incorrect sidecar results fail.
The test also requires the accessible window name to be Maple and stops its
owned process. It does not qualify screen-reader speech, every control, display
color, a real cloud account or physical-GPU timing.
