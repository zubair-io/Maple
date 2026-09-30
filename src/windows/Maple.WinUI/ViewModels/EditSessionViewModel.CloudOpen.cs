using System;
using System.Threading;
using System.Threading.Tasks;
using CommunityToolkit.Mvvm.ComponentModel;
using Maple.WinUI.Services;

namespace Maple.WinUI.ViewModels;

public partial class EditSessionViewModel
{
    [ObservableProperty] private bool _adjustmentsReady;
    [ObservableProperty] private bool _hasSidecarLoadError;
    [ObservableProperty] private string _sidecarLoadError = string.Empty;
    private int _photoOpenVersion;
    private int _cloudDecodeRequestVersion = -1;

    public async Task RetryCloudSidecarAsync()
    {
        var photo = SelectedPhoto;
        if (photo?.IsCloud != true || !HasSidecarLoadError) return;
        HasSidecarLoadError = false;
        SidecarLoadError = string.Empty;
        IsDecoding = true;
        DecodeStatus = "Loading saved adjustments…";
        _cloudSidecarLoad = LoadCloudSidecarAsync(photo);
        await _cloudSidecarLoad;
        if (ReferenceEquals(SelectedPhoto, photo))
        {
            IsDecoding = false;
            if (AdjustmentsReady) EnsureDecoded();
        }
    }

    /// <summary>Fetch + apply the server sidecar after a cloud photo opens.
    /// No sidecar (404) keeps the default state.</summary>
    private async Task LoadCloudSidecarAsync(PhotoItem photo)
    {
        var version = _photoOpenVersion;
        try
        {
            var client = _cloud ?? throw new InvalidOperationException("Not connected to Maple Cloud.");
            var xml = await client.ReadMetadataXmpAsync(photo.FilePath, CancellationToken.None);
            if (_disposed || version != _photoOpenVersion || !ReferenceEquals(_openPhoto, photo))
                return;
            var doc = xml == null ? new Services.Xmp.XmpSidecarDocument()
                : Services.Xmp.XmpParser.Parse(xml) ?? throw new InvalidOperationException("The server sidecar is invalid.");
            await OnUiAcknowledgedAsync(() =>
            {
                if (_disposed || version != _photoOpenVersion || !ReferenceEquals(_openPhoto, photo))
                    return;
                _cloudDoc = doc;
                Adjustments = doc.Adjustments;
                _originalModel = Adjustments.Clone();
                OpeningSnapshotVersion++;
                _undoBaseline = Adjustments.Clone();
                if (doc.Rating is { } rating) photo.Rating = rating;
                if (doc.Flag is { } flag) photo.FlagStatus = flag;
                if (doc.ColorLabel != null) photo.ColorLabel = doc.ColorLabel;
                AdjustmentsReady = true;
                SyncSlidersFromModel();
                Renderer.RequestRender(Adjustments.Clone());
            });
        }
        catch (Exception ex)
        {
            await OnUiAcknowledgedAsync(() =>
            {
                if (_disposed || version != _photoOpenVersion || !ReferenceEquals(_openPhoto, photo)) return;
                SidecarLoadError = $"Could not load saved adjustments: {ex.Message}";
                HasSidecarLoadError = true;
                CloudStatus = SidecarLoadError;
            });
            DiagLog.Write($"[cloud] sidecar fetch failed for {photo.FileName}: {ex.Message}");
        }
    }

    /// <summary>Edit entry for a cloud asset: stream the original into the
    /// local cache (with progress), then run the normal decode. Selection
    /// changes mid-download are abandoned quietly.</summary>
    private async Task DownloadThenDecodeAsync(PhotoItem photo)
    {
        var version = _photoOpenVersion;
        if (_cloudDecodeRequestVersion == version) return;
        _cloudDecodeRequestVersion = version;
        IsDecoding = true;
        DecodeStatus = "Loading saved adjustments…";
        try
        {
            await _cloudSidecarLoad;
            if (_disposed || version != _photoOpenVersion || !ReferenceEquals(SelectedPhoto, photo)) return;
            if (!AdjustmentsReady)
            {
                IsDecoding = false;
                DecodeStatus = SidecarLoadError;
                return;
            }
            var client = _cloud ?? throw new InvalidOperationException("Not connected to Maple Cloud.");
            DecodeStatus = $"Downloading {photo.FileName}…";
            var lastPercent = -1;
            var path = photo.LocalCachePath ?? await client.DownloadOriginalAsync(
                photo.FilePath, photo.FileSizeBytes,
                (received, total) =>
                {
                    if (total <= 0)
                        return;
                    var percent = (int)(received * 100 / total);
                    if (percent == lastPercent)
                        return;
                    lastPercent = percent;
                    OnUi(() =>
                    {
                        if (!_disposed && version == _photoOpenVersion && ReferenceEquals(SelectedPhoto, photo) && _decodedPhoto == null)
                            DecodeStatus = $"Downloading {photo.FileName}… {percent}%";
                    });
                },
                CancellationToken.None);
            if (_disposed || version != _photoOpenVersion || !ReferenceEquals(SelectedPhoto, photo))
                return;
            if (path == null)
            {
                IsDecoding = false;
                DecodeStatus = "Download failed — see maple.log";
                return;
            }
            photo.LocalCachePath = path;
            _decodedPhoto = photo;
            DecodeCurrent(photo);
        }
        catch (Exception ex)
        {
            DiagLog.Write($"[cloud] original download failed for {photo.FileName}: {ex.Message}");
            if (!_disposed && version == _photoOpenVersion && ReferenceEquals(SelectedPhoto, photo))
            {
                IsDecoding = false;
                DecodeStatus = $"Download failed: {ex.Message}";
            }
        }
        finally
        {
            if (_cloudDecodeRequestVersion == version) _cloudDecodeRequestVersion = -1;
        }
    }

}
