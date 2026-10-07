using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Maple.WinUI.ViewModels;

namespace Maple.WinUI
{
    /// <summary>
    /// Headless-ish qualification mode (#2587) — the Windows counterpart of
    /// the Apple UITest visual harness, driven by environment variables so
    /// src/windows/scripts/qualify-winui.ps1 can run it unattended:
    ///
    ///   MAPLE_QUALIFY_RAW=&lt;raw path&gt;   photo to open in Edit
    ///   MAPLE_QUALIFY_OUT=&lt;dir&gt;        where report.json lands
    ///
    /// The run decodes, then times TICKS wiggling Exposure ±0.01 through the
    /// real render loop (GPU presents, or CPU ticks under MAPLE_FORCE_CPU=1;
    /// combine the CPU run with MAPLE_DUMP_FRAME for the pixel-exact parity
    /// frame), writes the timing report and a production export on the CPU
    /// run, and exits.
    /// </summary>
    public sealed partial class MainWindow
    {
        private const int QualifyTicks = 20;

        private void MaybeStartQualifyRun()
        {
            var raw = Environment.GetEnvironmentVariable("MAPLE_QUALIFY_RAW");
            var outDir = Environment.GetEnvironmentVariable("MAPLE_QUALIFY_OUT");
            if (string.IsNullOrEmpty(raw) || string.IsNullOrEmpty(outDir))
                return;
            _ = RunQualifyAsync(raw!, outDir!);
        }

        private async Task RunQualifyAsync(string rawPath, string outDir)
        {
            var exitCode = 0;
            var ticks = new List<double>();
            var renderTicks = new List<double>();
            var refines = new List<double>();
            var path = "gpu";
            long decodeStarted = 0;
            long pendingEditStarted = 0;
            double? decodeMs = null;
            double? initialExposure = null;
            try
            {
                Directory.CreateDirectory(outDir);
                // Every edit produces exactly TWO frames on both render paths:
                // the interactive fast tick, then the debounced full-res
                // refine (LoopAsync's two-phase contract). Queue them and
                // consume by SEQUENCE — frame #1 after a wiggle is the fast
                // tick (the 16ms-target metric), frame #2 the refine (allowed
                // to be slow; reported, not gated). Awaiting the refine before
                // the next wiggle also keeps its GPU work from overlapping the
                // next measured tick.
                var frameTimes = new System.Collections.Concurrent.ConcurrentQueue<(double RenderMs, long Completed)>();
                var frameSignal = new SemaphoreSlim(0);
                ViewModel.Renderer.GpuFrameReady += (_, _, _, ms, _) =>
                {
                    frameTimes.Enqueue((ms, System.Diagnostics.Stopwatch.GetTimestamp()));
                    frameSignal.Release();
                };
                ViewModel.Renderer.FrameReady += (_, _, _, _, _, ms) =>
                {
                    path = "cpu";
                    frameTimes.Enqueue((ms, System.Diagnostics.Stopwatch.GetTimestamp()));
                    frameSignal.Release();
                };
                async Task<(double RenderMs, long Completed)> NextFrameAsync()
                {
                    // A missing frame means the two-frames-per-edit contract
                    // broke — fail the run loudly instead of hanging forever.
                    if (!await frameSignal.WaitAsync(TimeSpan.FromSeconds(30)))
                        throw new TimeoutException(
                            "qualify: no render frame within 30s (fast/refine contract broken)");
                    if (!frameTimes.TryDequeue(out var ms))
                        throw new InvalidOperationException(
                            "qualify: frame signal fired with an empty queue");
                    return ms;
                }

                var photo = new PhotoItem
                {
                    FilePath = rawPath,
                    FileName = Path.GetFileName(rawPath),
                    Format = Path.GetExtension(rawPath).TrimStart('.').ToUpperInvariant(),
                };
                decodeStarted = System.Diagnostics.Stopwatch.GetTimestamp();
                SetMode(ShellMode.Edit);
                ViewModel.SelectedPhoto = photo;
                ViewModel.EnsureDecoded();

                // First frame = decode + first render complete; then drain the
                // initial refine so it can't bleed into the first measured tick.
                var initialFrame = await NextFrameAsync();
                decodeMs = System.Diagnostics.Stopwatch.GetElapsedTime(decodeStarted, initialFrame.Completed).TotalMilliseconds;
                await NextFrameAsync();

                // Capture the production export snapshot before timing edits,
                // exactly as the export dialog does. Export after measurement
                // so full-resolution work cannot contaminate fast-tick samples.
                var exportInputs = await ViewModel.CaptureExportInputsAsync();
                var exposure = ViewModel.Sections.SelectMany(section => section.Sliders)
                    .Single(slider => slider.Label == "Exposure");
                initialExposure = exposure.Value;

                for (var i = 0; i < QualifyTicks; i++)
                {
                    var editStarted = System.Diagnostics.Stopwatch.GetTimestamp();
                    pendingEditStarted = editStarted;
                    exposure.Value += i % 2 == 0 ? 0.01 : -0.01;
                    var frame = await NextFrameAsync();
                    ticks.Add(System.Diagnostics.Stopwatch.GetElapsedTime(editStarted, frame.Completed).TotalMilliseconds);
                    renderTicks.Add(frame.RenderMs);
                    pendingEditStarted = 0;
                    refines.Add((await NextFrameAsync()).RenderMs);
                }

                var sorted = ticks.OrderBy(v => v).ToList();
                var sortedRefines = refines.OrderBy(v => v).ToList();
                var report = new
                {
                    raw = rawPath,
                    render_path = path,
                    timing_clock = "Stopwatch",
                    timing_frequency_hz = System.Diagnostics.Stopwatch.Frequency,
                    timing_high_resolution = System.Diagnostics.Stopwatch.IsHighResolution,
                    decode_ms = decodeMs,
                    initial_exposure = initialExposure,
                    timing_scope = path == "gpu" ? "exposure-edit-to-present-return" : "exposure-edit-to-cpu-render-ready",
                    tick_ms = ticks,
                    render_tick_ms = renderTicks,
                    median_ms = (sorted[(sorted.Count - 1) / 2] + sorted[sorted.Count / 2]) / 2,
                    p95_ms = sorted[(int)Math.Min(sorted.Count - 1, Math.Ceiling(sorted.Count * 0.95) - 1)],
                    target_ms = 16.0,
                    hard_limit_ms = 50.0,
                    refine_ms = refines,
                    refine_median_ms = (sortedRefines[(sortedRefines.Count - 1) / 2] + sortedRefines[sortedRefines.Count / 2]) / 2,
                };
                await File.WriteAllTextAsync(
                    Path.Combine(outDir, "report.json"),
                    JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = true }));

                // Give the histogram quiet-tick (and MAPLE_DUMP_FRAME on the
                // CPU run) time to land before exiting.
                await Task.Delay(1500);
                if (path == "cpu") await WriteQualificationExportAsync(exportInputs, outDir);
            }
            catch (Exception ex)
            {
                exitCode = 1;   // the harness must see failure as failure
                Services.DiagLog.Write($"[qualify] failed: {ex.Message}");
                try
                {
                    await File.WriteAllTextAsync(
                        Path.Combine(outDir, "report.json"),
                        JsonSerializer.Serialize(new
                        {
                            error = ex.Message,
                            raw = rawPath,
                            render_path = path,
                            timing_clock = "Stopwatch",
                            timing_frequency_hz = System.Diagnostics.Stopwatch.Frequency,
                            timing_high_resolution = System.Diagnostics.Stopwatch.IsHighResolution,
                            timing_scope = path == "gpu" ? "exposure-edit-to-present-return" : "exposure-edit-to-cpu-render-ready",
                            decode_ms = decodeMs,
                            initial_exposure = initialExposure,
                            elapsed_open_ms = decodeStarted == 0 ? (double?)null : System.Diagnostics.Stopwatch.GetElapsedTime(decodeStarted).TotalMilliseconds,
                            incomplete_fast_tick_ms = pendingEditStarted == 0 ? (double?)null : System.Diagnostics.Stopwatch.GetElapsedTime(pendingEditStarted).TotalMilliseconds,
                            tick_ms = ticks,
                            render_tick_ms = renderTicks,
                            refine_ms = refines,
                        }, new JsonSerializerOptions { WriteIndented = true }));
                }
                catch (IOException) { /* report is best-effort on failure */ }
            }
            finally
            {
                Environment.ExitCode = exitCode;
                await ShutdownAsync();
                _closeReady = true;
                Close();
            }
        }

        private static async Task WriteQualificationExportAsync(
            System.Collections.Generic.IReadOnlyList<Services.Export.ExportInput> inputs, string outDir)
        {
            var destination = Path.Combine(outDir, "export");
            Directory.CreateDirectory(destination);
            var runner = new Services.Export.ExportQueueRunner(
                new Services.Export.ExportQueueStore(Path.Combine(outDir, "export-ledger")),
                new Services.Export.NativeExportRecipeExecutor());
            var recipe = new Generated.ExportRecipe
            {
                SchemaVersion = 1, Name = "Qualification full resolution", Format = "tiff",
                Quality = null, BitDepth = 16, MaxLongEdge = null, OutputProfile = "srgb",
                RenderingIntent = "maple-display", MetadataPolicy = "strip",
                NamingTemplate = "qualification.{ext}", Destination = "directory",
                Directory = destination, Watermark = null, OverwritePolicy = "error",
            };
            var job = runner.Create(recipe, inputs, inputs.Select(input => input.SourcePath));
            var result = await runner.RunAsync(job.Id, false, System.Threading.CancellationToken.None);
            if (result.Entries.Count != 1 || result.Entries[0].Status != "applied")
                throw new IOException("Qualification export failed: " +
                    string.Join("; ", result.Entries.Select(entry => entry.Reason ?? entry.Status)));
            await File.WriteAllTextAsync(Path.Combine(outDir, "export-result.json"),
                JsonSerializer.Serialize(new { output = result.Entries[0].OutputPath,
                    sha256 = result.Entries[0].AfterHash, source_sha256 = result.Entries[0].SourceHash }));
        }
    }
}
