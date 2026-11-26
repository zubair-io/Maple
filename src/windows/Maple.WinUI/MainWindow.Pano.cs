using System;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI.Atoms;
using Windows.Graphics.Imaging;
using Maple.WinUI.Services;
using Maple.WinUI.Services.Pano;
using Maple.WinUI.Views;

namespace Maple.WinUI
{
    /// <summary>
    /// Panorama stitching UI (#2583) — a one-off, user-selected action over
    /// the grid multi-selection, run through the maple-cli subprocess (the
    /// Self-Hosted API's route). The classical matcher needs no download;
    /// the opt-in ML matcher provisions its models on first use (#4556).
    /// The scene-linear 16-bit master PNG lands beside the frames for
    /// interop; the display output is converted to a grid-native JPEG,
    /// which the library watcher (#2585) picks up live.
    /// </summary>
    public sealed partial class MainWindow
    {
        private async void OnStitchPano(object sender, RoutedEventArgs e) =>
            // Gated end-to-end (#2948): this handler opens its own
            // provisioning-check and options ContentDialogs before ever
            // reaching RunPanoAsync's progress dialog, so a re-entrant call
            // landing before those close would hit the second-ShowAsync
            // crash earlier still. See MainWindow.DragDrop.cs's
            // _modalFlowGate — shared with RunDragMoveAsync/
            // OnMoveToFolder/OnBatchRename for the same reason.
            await RunModalFlowGuardedAsync(() => RunOnStitchPanoAsync());

        private async Task RunOnStitchPanoAsync()
        {
            // Pano ingest is RAW-only (the CLI's rawler decode rejects
            // JPEG/TIFF) — silently skip non-RAW members of the selection so
            // a CR2+JPG pair range-select still stitches the RAWs.
            var frames = ViewModel.SelectedPhotos
                .Where(p => !p.IsCloud && IsRawFrame(p.FilePath))
                .Select(p => p.FilePath)
                .OrderBy(p => p, StringComparer.OrdinalIgnoreCase)
                .ToList();
            if (frames.Count < 2)
            {
                await ShowMessageAsync("Panorama",
                    "Select two or more local RAW frames in the grid first "
                    + "(Ctrl-click or Shift-click; JPEG/TIFF frames are skipped). "
                    + "Frames stitch in filename order.");
                return;
            }

            var settings = AppSettings.Load();
            var provisioner = new PanoProvisioner(settings);
            var engine = PanoFeatureEngines.FromSetting(settings.PanoUseMlMatcher);
            // The ML check is ~180 MB of hash verification — never on the UI thread.
            var state = await provisioner.CheckAsync(engine);
            var panel = new StackPanel { Spacing = 10, Width = 460 };
            panel.Children.Add(new MuiText
            {
                Text = $"{frames.Count} frames, stitched in filename order with the "
                     + (engine == PanoFeatureEngine.Ml ? "ML" : "classical")
                     + " matcher. This can take several minutes.",
                Variant = MuiTextVariant.Body,
            });
            var seams = new PanoSeamAuthoring();
            var seamEditor = new PanoSeamEditor(seams);
            var previewPane = new PanoPreviewPane(DispatcherQueue, seamEditor.Overlay.Root);
            panel.Children.Add(previewPane.Root);
            // The preview stays pinned; everything under it scrolls.
            var options = new StackPanel { Spacing = 10 };
            panel.Children.Add(new ScrollViewer
            {
                Content = options,
                MaxHeight = 300,
                VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
                Padding = new Thickness(0, 0, 14, 0),
            });
            var retentionCombo = new ComboBox
            {
                HorizontalAlignment = HorizontalAlignment.Stretch,
                Header = "Frame retention",
            };
            retentionCombo.Items.Add("Keep — tolerate weaker frames");
            retentionCombo.Items.Add("Strict — drop frames that align poorly");
            retentionCombo.SelectedIndex = 0;
            options.Children.Add(retentionCombo);
            var alignCombo = new ComboBox
            {
                HorizontalAlignment = HorizontalAlignment.Stretch,
                Header = "Local alignment",
            };
            alignCombo.Items.Add("Mesh — absorb parallax (rotation and drone survey)");
            alignCombo.Items.Add("Off — global alignment only");
            alignCombo.SelectedIndex = 0;
            options.Children.Add(alignCombo);
            var strategyCombo = new ComboBox
            {
                HorizontalAlignment = HorizontalAlignment.Stretch,
                Header = "Strategy",
            };
            foreach (var label in new[] { "Auto", "Rotation (tripod pan)", "Tile (translated mosaic)" })
                strategyCombo.Items.Add(label);
            strategyCombo.SelectedIndex = 0;
            options.Children.Add(strategyCombo);
            var provisionText = new MuiText
            {
                Text = state.Summary,
                Variant = MuiTextVariant.Body,
                ColorRole = MuiTextColorRole.Muted,
            };
            options.Children.Add(provisionText);
            if (state.NeedsDownload)
            {
                options.Children.Add(new MuiText
                {
                    Text = "First run downloads the pinned ALIKED + LightGlue models "
                         + "(~57 MB, SHA-256 verified) and ONNX Runtime 1.23.2 "
                         + "(~120 MB) from their official releases into "
                         + @"%LOCALAPPDATA%\Maple.",
                    Variant = MuiTextVariant.Body,
                    ColorRole = MuiTextColorRole.Muted,
                });
            }
            options.Children.Add(seamEditor.Root);

            var dialog = new ContentDialog
            {
                Title = "Stitch Panorama",
                Content = panel,
                PrimaryButtonText = state.NeedsDownload ? "Download & create panorama" : "Create panorama",
                CloseButtonText = "Cancel",
                DefaultButton = ContentDialogButton.Primary,
                XamlRoot = (this.Content as FrameworkElement)?.XamlRoot,
            };

            PanoPreviewOptions SelectedOptions() => new(
                retentionCombo.SelectedIndex == 1 ? "strict" : "keep",
                alignCombo.SelectedIndex == 1 ? "off" : "mesh",
                strategyCombo.SelectedIndex switch
                {
                    1 => "rotation",
                    2 => "tile",
                    _ => "auto",
                });

            using var scratch = PanoScratch.Create();
            var preview = new PanoPreviewSession(scratch,
                (run, ct) => PanoService.PreviewAsync(
                    provisioner, frames, run, engine,
                    line => OnUiThread(() => previewPane.Report(line)), ct),
                PanoPreviewSession.DefaultDebounce);
            preview.Started += _ => OnUiThread(previewPane.Started);
            preview.Failed += error => OnUiThread(() => previewPane.Failed(error));

            var dialogClosed = false;
            void RequestPreview(PanoSeamRequest? regions)
            {
                if (dialogClosed)
                    return;
                seams.PreviewRequested();
                preview.Request(SelectedOptions(), regions);
            }
            async Task OnPreviewCompletedAsync(PanoPreviewCompletion completion)
            {
                var sequence = completion.Run.Sequence;
                var isLatest = sequence == preview.LatestSequence;
                var verdict = seams.PreviewCompleted(completion, isLatest);
                if (verdict.Message is not null)
                    seamEditor.ShowMessage(verdict.Message);
                if (verdict.PreviewAgain)
                    RequestPreview(null);
                if (!completion.Outcome.Ok || !isLatest || verdict.PreviewAgain)
                    return;
                var shown = await previewPane.ShowAsync(completion.Run.Files.PreviewPng);
                if (dialogClosed)
                    return;
                if (shown)
                    seams.ImageShown(sequence);
                else
                    seams.ImageFailed(sequence);
            }
            preview.Completed += completion => OnUiThread(() => _ = OnPreviewCompletedAsync(completion));
            seams.Changed += () => dialog.IsPrimaryButtonEnabled = seams.CanSubmit;
            dialog.PrimaryButtonClick += (_, args) => args.Cancel = seamEditor.OwnsFocus(dialog.XamlRoot);

            var provisioned = !state.NeedsDownload;
            using var provisionCts = new CancellationTokenSource();
            var provisioning = Task.CompletedTask;
            async Task ProvisionThenPreviewAsync()
            {
                try
                {
                    await Task.Run(() => provisioner.ProvisionAsync(
                        line => OnUiThread(() => previewPane.Report(line)), provisionCts.Token), provisionCts.Token);
                    provisioned = true;
                    previewPane.DownloadFinished();
                    dialog.PrimaryButtonText = "Create panorama";
                    RequestPreview(null);
                }
                catch (OperationCanceledException) when (provisionCts.IsCancellationRequested)
                {
                    // The dialog closed mid-download; the stitch provisions again if chosen.
                }
                catch (Exception ex)
                {
                    previewPane.DownloadFailed(ex.Message);
                }
            }

            foreach (var combo in new[] { retentionCombo, alignCombo, strategyCombo })
            {
                combo.SelectionChanged += (_, _) =>
                {
                    seams.GeometryChanged(SelectedOptions().Strategy);
                    seamEditor.ShowMessage(null);
                    if (provisioned)
                        RequestPreview(null);
                };
            }
            seamEditor.PreviewRequested += () =>
            {
                if (provisioned && seams.CanAuthor)
                    RequestPreview(seams.Request);
            };
            seams.GeometryChanged(SelectedOptions().Strategy);
            if (provisioned)
                RequestPreview(null);
            else
                previewPane.OfferDownload(
                    "The preview needs the ML matcher's models.",
                    () => provisioning = ProvisionThenPreviewAsync());

            var choice = await dialog.ShowAsync();
            dialogClosed = true;
            provisionCts.Cancel();
            await provisioning;
            await preview.StopAsync();
            previewPane.Stop();
            if (choice != ContentDialogResult.Primary)
                return;

            var chosen = SelectedOptions();
            // A download finished inside the dialog leaves nothing to fetch.
            var stitchState = provisioned && state.NeedsDownload
                ? state with { Models = true, Ort = true }
                : state;
            await RunPanoAsync(provisioner, stitchState, frames,
                chosen.Retention, chosen.LocalAlign, chosen.Strategy, preview.LatestAlignment,
                seams.Request is { } drawn ? scratch.SeamStitch(drawn) : null);
        }

        private async Task RunPanoAsync(
            PanoProvisioner provisioner, PanoProvisionState state,
            System.Collections.Generic.List<string> frames,
            string retention, string localAlign, string strategy, string? alignmentIn, PanoSeamStitch? seams)
        {
            var folder = Path.GetDirectoryName(frames[0])!;
            var stem = Path.GetFileNameWithoutExtension(frames[0]);
            var baseName = PanoOutputFiles.UniqueBaseName(folder, $"{stem}-pano");
            var outPath = PanoOutputFiles.MasterPath(folder, baseName);
            var displayTemp = Path.Combine(Path.GetTempPath(), $"maple-pano-{Guid.NewGuid():N}.png");
            var jpegPath = PanoOutputFiles.JpegPath(folder, baseName);

            var cts = new CancellationTokenSource();
            var progressView = new PanoProgressView(DispatcherQueue);
            progressView.Root.Width = 380;
            progressView.Start("Preparing…");
            var progressDialog = new ContentDialog
            {
                Title = "Stitching panorama…",
                Content = progressView.Root,
                CloseButtonText = "Cancel",
                XamlRoot = (this.Content as FrameworkElement)?.XamlRoot,
            };
            progressDialog.CloseButtonClick += (_, _) => cts.Cancel();
            var progressShown = progressDialog.ShowAsync();
            void Status(string text) => OnUiThread(() => progressView.Report(text));
            string? alignmentStatus = null;
            void StitchLine(string line)
            {
                alignmentStatus = PanoProgressLine.AlignmentStatus(line) ?? alignmentStatus;
                Status(line);
            }

            try
            {
                if (state.NeedsDownload)
                    await Task.Run(() => provisioner.ProvisionAsync(Status, cts.Token), cts.Token);

                Status($"Stitching {frames.Count} frames…");
                var result = await Task.Run(() => PanoService.StitchAsync(
                    provisioner, frames, outPath, displayTemp,
                    retention, localAlign, strategy, state.Engine, alignmentIn, seams, StitchLine, cts.Token), cts.Token);
                var leftover = result.Ok ? null : PanoOutputFiles.DiscardPartial(outPath);

                if (result.Ok)
                {
                    Status("Encoding preview JPEG…");
                    await ConvertDisplayPngToJpegAsync(displayTemp, jpegPath);
                }
                progressDialog.Hide();
                await progressShown;
                if (result.Ok)
                {
                    // The library watcher adds the JPEG to the grid on its own.
                    await ShowMessageAsync("Panorama",
                        $"Stitched {frames.Count} frames.\n\n"
                        + $"Result: {Path.GetFileName(jpegPath)}\n"
                        + $"Scene-linear master: {Path.GetFileName(outPath)}"
                        + AlignmentNote(alignmentIn, result.AlignmentStatus ?? alignmentStatus));
                }
                else if (result.Error != "cancelled" || leftover is not null)
                {
                    var cancelled = result.Error == "cancelled";
                    await ShowMessageAsync(
                        cancelled ? "Panorama cancelled" : "Panorama failed",
                        string.Join("\n\n", new[] { cancelled ? null : result.Error ?? "unknown error", leftover }.OfType<string>()));
                }
            }
            catch (OperationCanceledException)
            {
                progressDialog.Hide();
            }
            catch (Exception ex)
            {
                progressDialog.Hide();
                await progressShown;
                await ShowMessageAsync("Panorama failed", ex.Message);
            }
            finally
            {
                progressView.Show(string.Empty);
                try { File.Delete(displayTemp); } catch { /* best effort */ }
            }
        }

        private static string AlignmentNote(string? alignmentIn, string? status) =>
            (alignmentIn, status) switch
            {
                (null, _) => string.Empty,
                (_, "reused") => "\n\nAlignment reused from the preview, so frames were not matched again.",
                (_, "stale") => "\n\nThe preview's alignment no longer matched the frames or options, so they were matched again.",
                _ => string.Empty,
            };

        private static bool IsRawFrame(string path) =>
            Path.GetExtension(path).ToLowerInvariant()
                is not (".jpg" or ".jpeg" or ".tif" or ".tiff");

        /// <summary>16-bit sRGB display PNG → quality-95 JPEG via WIC, so the
        /// stitch result is a first-class grid asset (thumbs, edit, export).</summary>
        private static async Task ConvertDisplayPngToJpegAsync(string pngPath, string jpegPath)
        {
            using var input = File.OpenRead(pngPath);
            var decoder = await BitmapDecoder.CreateAsync(input.AsRandomAccessStream());
            var pixels = await decoder.GetPixelDataAsync(
                BitmapPixelFormat.Bgra8, BitmapAlphaMode.Ignore,
                new BitmapTransform(), ExifOrientationMode.IgnoreExifOrientation,
                ColorManagementMode.DoNotColorManage);
            using var output = File.Create(jpegPath);
            var propertySet = new BitmapPropertySet
            {
                ["ImageQuality"] = new BitmapTypedValue(0.95f, Windows.Foundation.PropertyType.Single),
            };
            var encoder = await BitmapEncoder.CreateAsync(
                BitmapEncoder.JpegEncoderId, output.AsRandomAccessStream(), propertySet);
            encoder.SetPixelData(BitmapPixelFormat.Bgra8, BitmapAlphaMode.Ignore,
                decoder.PixelWidth, decoder.PixelHeight, 96, 96, pixels.DetachPixelData());
            await encoder.FlushAsync();
        }

        private static void OnUiThread(Action action)
        {
            var queue = App.MainDispatcherQueue;
            if (queue == null || queue.HasThreadAccess)
                action();
            else
                queue.TryEnqueue(() => action());
        }
    }
}
