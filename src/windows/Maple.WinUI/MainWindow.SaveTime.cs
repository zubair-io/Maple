using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.UI.Xaml;
using Maple.WinUI.Services;
using Maple.WinUI.Services.Xmp;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private CancellationTokenSource? _saveTimeRequest;
    private readonly DispatcherTimer _saveTimeTimer = new() { Interval = TimeSpan.FromMinutes(1) };

    private void InitializeSaveTime()
    {
        ViewModel.SidecarSaved += RefreshSaveTime;
        _saveTimeTimer.Tick += (_, _) => RefreshSaveTime();
        _saveTimeTimer.Start();
    }

    private void StopSaveTime()
    {
        _saveTimeTimer.Stop();
        _saveTimeRequest?.Cancel();
        ViewModel.SidecarSaved -= RefreshSaveTime;
    }

    private async void RefreshSaveTime()
    {
        _saveTimeRequest?.Cancel();
        var photo = ViewModel.SelectedPhoto;
        BrowseSavedStatus.Text = string.Empty;
        if (_closing || photo == null) return;
        using var request = new CancellationTokenSource();
        _saveTimeRequest = request;
        try
        {
            DateTimeOffset? saved;
            if (photo.IsCloud)
            {
                var client = ViewModel.ActiveCloudClient;
                if (client == null) return;
                var metadata = await client.GetInspectorMetadataAsync(photo.FilePath, request.Token);
                saved = metadata?.XmpModifiedSeconds is { } seconds
                    ? DateTimeOffset.FromUnixTimeSeconds(seconds) : null;
            }
            else
            {
                saved = await Task.Run(() =>
                {
                    var sidecar = new FileInfo(SidecarStore.SidecarPathFor(photo.FilePath));
                    return sidecar.Exists ? (DateTimeOffset?)sidecar.LastWriteTimeUtc : null;
                }, request.Token);
            }
            if (_closing || request.IsCancellationRequested || !ReferenceEquals(photo, ViewModel.SelectedPhoto)) return;
            BrowseSavedStatus.Text = SaveTimeLabel.Format(saved, DateTimeOffset.UtcNow);
        }
        catch (OperationCanceledException) { }
        catch (Exception error) { DiagLog.Write($"[browse] save time unavailable: {error.Message}"); }
        finally
        {
            if (ReferenceEquals(_saveTimeRequest, request)) _saveTimeRequest = null;
        }
    }
}
