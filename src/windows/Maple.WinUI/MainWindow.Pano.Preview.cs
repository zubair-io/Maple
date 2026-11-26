using System;
using System.IO;
using System.Threading.Tasks;
using Maple.UI.Atoms;
using Maple.WinUI.Services.Pano;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media.Imaging;
using Windows.Graphics.Imaging;

namespace Maple.WinUI
{
    public sealed partial class MainWindow
    {
        /// <summary>The stitch dialog's quick preview (#4581): the latest
        /// ~2048 px preview image above the progress of the run building
        /// the next one. The image is sized to its own shape inside a fixed
        /// box, so the seam overlay (#5992) laid over the same box covers
        /// exactly the picture. UI-thread only.</summary>
        private sealed class PanoPreviewPane
        {
            private const double BoxHeight = 200;

            private readonly MuiImage _image = new()
            {
                Fit = MuiImageFit.Uniform,
                Height = BoxHeight,
                ImageCornerRadius = 6,
                AccessibleLabel = "Panorama preview",
            };
            private readonly Grid _box = new() { Height = BoxHeight };
            private readonly PanoProgressView _progress;
            private readonly MuiButton _download = new()
            {
                Label = "Download models and preview",
                Variant = MuiButtonVariant.Secondary,
                Visibility = Visibility.Collapsed,
            };
            private SoftwareBitmapSource? _shown;
            private PanoSeamCanvas? _pixels;

            public PanoPreviewPane(DispatcherQueue queue, UIElement? overlay = null)
            {
                _progress = new PanoProgressView(queue);
                _box.Children.Add(_image);
                if (overlay is not null)
                    _box.Children.Add(overlay);
                _box.SizeChanged += (_, _) => FitImage();
                Root = new StackPanel { Spacing = 8, Children = { _box, _progress.Root, _download } };
            }

            public StackPanel Root { get; }

            public void OfferDownload(string message, Action download)
            {
                _progress.Show(message);
                _download.Visibility = Visibility.Visible;
                _download.IsEnabled = true;
                _download.Click += (_, _) =>
                {
                    _download.IsEnabled = false;
                    _progress.Start("Downloading the alignment models…");
                    download();
                };
            }

            public void DownloadFailed(string error)
            {
                _progress.Finish($"Download failed: {error}");
                _download.IsEnabled = true;
            }

            public void DownloadFinished() => _download.Visibility = Visibility.Collapsed;

            public void Started() => _progress.Start("Building a quick preview…");

            public void Report(string line) => _progress.Report(line);

            public void Failed(string error) => _progress.Finish($"Preview failed: {error}");

            /// <summary>The dialog closed: stop the clock and release the
            /// decoded preview.</summary>
            public void Stop()
            {
                _progress.Show(string.Empty);
                _image.Source = null;
                _shown?.Dispose();
                _shown = null;
            }

            public async Task<bool> ShowAsync(string previewPng)
            {
                try
                {
                    var (source, pixels) = await LoadPngAsync(previewPng);
                    _image.Source = source;
                    _shown?.Dispose();
                    _shown = source;
                    _pixels = pixels;
                    FitImage();
                    _progress.Finish("Preview ready. Changing an option refreshes it.");
                    return true;
                }
                catch (Exception ex)
                {
                    _progress.Finish($"Preview could not be shown: {ex.Message}");
                    return false;
                }
            }

            private void FitImage()
            {
                if (_pixels is not { } pixels)
                    return;
                var (width, height) = PanoSeamGeometry.Fit(pixels, _box.ActualWidth, BoxHeight);
                if (width <= 0)
                    return;
                // An element with an explicit size is centred in its slot.
                _image.Width = width;
                _image.Height = height;
            }

            private static async Task<(SoftwareBitmapSource Source, PanoSeamCanvas Pixels)> LoadPngAsync(string path)
            {
                using var input = File.OpenRead(path);
                var decoder = await BitmapDecoder.CreateAsync(input.AsRandomAccessStream());
                var bitmap = await decoder.GetSoftwareBitmapAsync(
                    BitmapPixelFormat.Bgra8, BitmapAlphaMode.Premultiplied,
                    new BitmapTransform(), ExifOrientationMode.IgnoreExifOrientation,
                    ColorManagementMode.DoNotColorManage);
                var source = new SoftwareBitmapSource();
                await source.SetBitmapAsync(bitmap);
                return (source, new PanoSeamCanvas((int)decoder.PixelWidth, (int)decoder.PixelHeight));
            }
        }
    }
}
