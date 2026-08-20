using System;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Windows.Graphics.Imaging;
using Maple.WinUI.Services;
using Maple.WinUI.Services.Pano;

namespace Maple.WinUI
{
    /// <summary>
    /// Panorama stitching UI (#2583) — a one-off, user-selected action over
    /// the grid multi-selection, run through the maple-cli subprocess (the
    /// Self-Hosted API's route). The scene-linear 16-bit master PNG lands
    /// beside the frames for interop; the display output is converted to a
    /// grid-native JPEG, which the library watcher (#2585) picks up live.
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

            var provisioner = new PanoProvisioner(AppSettings.Load());
            // ~180 MB of hash verification — never on the UI thread.
            var state = await provisioner.CheckAsync();
            var panel = new StackPanel { Spacing = 10, Width = 380 };
            panel.Children.Add(new TextBlock
            {
                Text = $"{frames.Count} frames, stitched in filename order. This runs "
                     + "the full ML alignment pipeline and can take several minutes.",
                TextWrapping = TextWrapping.Wrap,
                FontSize = 12,
            });
            var retentionCombo = new ComboBox
            {
                HorizontalAlignment = HorizontalAlignment.Stretch,
                Header = "Frame retention",
            };
            retentionCombo.Items.Add("Keep — tolerate weaker frames");
            retentionCombo.Items.Add("Strict — drop frames that align poorly");
            retentionCombo.SelectedIndex = 0;
            panel.Children.Add(retentionCombo);
            var alignCombo = new ComboBox
            {
                HorizontalAlignment = HorizontalAlignment.Stretch,
                Header = "Local alignment",
            };
            alignCombo.Items.Add("Mesh — local warp refinement");
            alignCombo.Items.Add("Off — global alignment only");
            alignCombo.SelectedIndex = 0;
            panel.Children.Add(alignCombo);
            var strategyCombo = new ComboBox
            {
                HorizontalAlignment = HorizontalAlignment.Stretch,
                Header = "Strategy",
            };
            foreach (var label in new[] { "Auto", "Rotation (tripod pan)", "Tile (translated mosaic)" })
                strategyCombo.Items.Add(label);
            strategyCombo.SelectedIndex = 0;
            panel.Children.Add(strategyCombo);
            var provisionText = new TextBlock
            {
                Text = state.Summary,
                FontSize = 11,
                TextWrapping = TextWrapping.Wrap,
                Opacity = 0.6,
            };
            panel.Children.Add(provisionText);
            if (!state.IsProvisioned)
            {
                panel.Children.Add(new TextBlock
                {
                    Text = "First run downloads the pinned ALIKED + LightGlue models "
                         + "(~57 MB, SHA-256 verified) and ONNX Runtime 1.23.2 "
                         + "(~120 MB) from their official releases into "
                         + @"%LOCALAPPDATA%\Maple.",
                    FontSize = 11,
                    TextWrapping = TextWrapping.Wrap,
                    Opacity = 0.6,
                });
            }

            var dialog = new ContentDialog
            {
                Title = "Stitch Panorama",
                Content = panel,
                PrimaryButtonText = state.IsProvisioned ? "Stitch" : "Download & Stitch",
                CloseButtonText = "Cancel",
                DefaultButton = ContentDialogButton.Primary,
                XamlRoot = (this.Content as FrameworkElement)?.XamlRoot,
            };
            if (await dialog.ShowAsync() != ContentDialogResult.Primary)
                return;

            var retention = retentionCombo.SelectedIndex == 1 ? "strict" : "keep";
            var localAlign = alignCombo.SelectedIndex == 1 ? "off" : "mesh";
            var strategy = strategyCombo.SelectedIndex switch
            {
                1 => "rotation",
                2 => "tile",
                _ => "auto",
            };
            await RunPanoAsync(provisioner, state.IsProvisioned, frames, retention, localAlign, strategy);
        }

        private async Task RunPanoAsync(
            PanoProvisioner provisioner, bool provisioned,
            System.Collections.Generic.List<string> frames,
            string retention, string localAlign, string strategy)
        {
            var folder = Path.GetDirectoryName(frames[0])!;
            var stem = Path.GetFileNameWithoutExtension(frames[0]);
            var baseName = UniqueBaseName(folder, $"{stem}-pano");
            var outPath = Path.Combine(folder, $"{baseName}-master.png");
            var displayTemp = Path.Combine(Path.GetTempPath(), $"maple-pano-{Guid.NewGuid():N}.png");
            var jpegPath = Path.Combine(folder, $"{baseName}.jpg");

            var cts = new CancellationTokenSource();
            var statusText = new TextBlock
            {
                Text = "Preparing…",
                TextWrapping = TextWrapping.Wrap,
                FontSize = 12,
                Width = 380,
            };
            var progressDialog = new ContentDialog
            {
                Title = "Stitching panorama…",
                Content = new StackPanel
                {
                    Spacing = 10,
                    Children = { new ProgressBar { IsIndeterminate = true }, statusText },
                },
                CloseButtonText = "Cancel",
                XamlRoot = (this.Content as FrameworkElement)?.XamlRoot,
            };
            progressDialog.CloseButtonClick += (_, _) => cts.Cancel();
            var progressShown = progressDialog.ShowAsync();
            void Status(string text) => OnUiThread(() => statusText.Text = text);

            try
            {
                if (!provisioned)
                    await Task.Run(() => provisioner.ProvisionAsync(Status, cts.Token), cts.Token);

                Status($"Stitching {frames.Count} frames…");
                var result = await Task.Run(() => PanoService.StitchAsync(
                    provisioner, frames, outPath, displayTemp,
                    retention, localAlign, strategy, Status, cts.Token), cts.Token);

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
                        + $"Scene-linear master: {Path.GetFileName(outPath)}");
                }
                else if (result.Error != "cancelled")
                {
                    await ShowMessageAsync("Panorama failed", result.Error ?? "unknown error");
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
                try { File.Delete(displayTemp); } catch { /* best effort */ }
            }
        }

        private static bool IsRawFrame(string path) =>
            Path.GetExtension(path).ToLowerInvariant()
                is not (".jpg" or ".jpeg" or ".tif" or ".tiff");

        private static string UniqueBaseName(string folder, string baseName)
        {
            if (!File.Exists(Path.Combine(folder, $"{baseName}.jpg"))
                && !File.Exists(Path.Combine(folder, $"{baseName}-master.png")))
                return baseName;
            for (var i = 2; ; i++)
            {
                var candidate = $"{baseName}-{i}";
                if (!File.Exists(Path.Combine(folder, $"{candidate}.jpg"))
                    && !File.Exists(Path.Combine(folder, $"{candidate}-master.png")))
                    return candidate;
            }
        }

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
