using System;
using System.Threading.Tasks;
using Maple.WinUI.Services;

namespace Maple.WinUI.ViewModels;

public partial class EditSessionViewModel
{
    private readonly Services.Cloud.CloudClientSlot _cloudSlot = new();
    private int _openCloudGeneration = -1;

    private Services.Cloud.CloudClient? _cloud
    {
        get => _cloudSlot.Current;
        set => _cloudSlot.Adopt(value);
    }

    private void DisposeCloudClient()
    {
        var previous = _cloud;
        _cloud = null;
        previous?.Dispose();
    }

    private async Task SettleCloudWritesAsync()
    {
        if (_openPhoto?.IsCloud == true)
        {
            await _cloudSidecarLoad;
            _sidecarTimer?.Dispose();
            FlushSidecarNow();
        }
        await _cloudMetadataWrites.DrainAsync(retryFailed: true);
        PublishPendingCloudPreview();
        await _cloudPreviewPublications.DrainAsync(retryFailed: true);
    }

    private async Task<string?> ReleaseCloudSessionAsync()
    {
        try
        {
            for (var pass = 0; pass < 2; pass++)
                await SettleCloudWritesAsync();
            if (_openPhoto?.IsCloud == true && _sidecarDirty)
                throw new InvalidOperationException("edits kept arriving while saving");
        }
        catch (Exception ex)
        {
            DiagLog.Write($"[cloud] pending saves failed while switching servers: {ex.Message}");
            var message = $"Pending changes could not be saved to the current server: {ex.Message}";
            CloudStatus = message;
            return message;
        }
        if (_selectedCloudFolder == null && !_isCloudTimeline && _openPhoto?.IsCloud != true)
            return null;
        _libraryCts?.Cancel();
        BeginBrowse();
        IsLibraryLoading = false;
        LibraryLoadStatus = string.Empty;
        CloudTree.Clear();
        _openPhoto = null;
        _cloudDoc = null;
        _cloudSidecarLoad = Task.CompletedTask;
        _cloudPreviewPending = null;
        return null;
    }
}
