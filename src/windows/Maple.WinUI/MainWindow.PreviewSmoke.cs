using System;
using System.IO;
using System.Threading.Tasks;
using Maple.WinUI.ViewModels;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private async Task VerifyPreviewRecoveryAsync(string raw, string output)
    {
        var originalPhoto = ViewModel.SelectedPhoto!;
        var originalMode = _mode;
        var delayedPath = Path.Combine(output, "preview-delayed.dng");
        async Task Wait(Func<bool> condition, string reason)
        {
            var end = Environment.TickCount64 + 90000;
            while (!condition() && Environment.TickCount64 < end) await Task.Delay(20);
            if (!condition()) throw new InvalidOperationException("Preview recovery: " + reason);
        }
        try
        {
            SetMode(ShellMode.Preview);
            ViewModel.SelectedPhoto = new PhotoItem
            {
                FilePath = delayedPath, FileName = "preview-delayed.dng", Format = "DNG",
            };
            await Wait(() => ViewModel.HasDecodeError, "missing original did not report failure");
            if (!RenderErrorBar.IsOpen || !RenderErrorBar.Message.Contains("Decode failed"))
                throw new InvalidOperationException("Missing preview did not expose an accessible error");
            // A previously unavailable original becomes available. This writes
            // only a newly created diagnostic fixture, never the source RAW.
            File.Copy(raw, delayedPath);
            OnRetryPreview(this, new Microsoft.UI.Xaml.RoutedEventArgs());
            await Wait(() => !ViewModel.IsDecoding && ViewModel.Renderer.DetailSource != null,
                "retry did not render the newly available original");
            if (ViewModel.HasDecodeError || RenderErrorBar.IsOpen || _mode != ShellMode.Preview)
                throw new InvalidOperationException("Preview retry retained failure or entered Edit");
        }
        finally
        {
            ViewModel.SelectedPhoto = originalPhoto;
            ViewModel.EnsureDecoded();
            await Wait(() => !ViewModel.IsDecoding && ViewModel.Renderer.DetailSource != null,
                "restoring the previous photo failed");
            SetMode(originalMode);
        }
    }
}
